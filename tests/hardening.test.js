'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  Bridge,
  FileQueue,
  WakeHandoff,
  RateLimiter,
  attachToClient,
  assertReady,
  clampConfig,
  defaultConfig,
  loadConfig,
} = require('../discord-bridge');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

const KEY = 'test-hmac-key-value';
const SECRET = 'zz-hook-path-9f3c';

function mention(id) {
  return fakeMessage({ id, username: 'user', displayName: 'User' });
}

function liveWake(dirs, options = {}) {
  const root = tempDir('phicc-hard-');
  dirs.push(root);
  let clock = 1_700_000_000_000;
  const posts = [];
  const timers = [];
  const log = memoryLogger();
  const limits = options.rateLimits || {
    perUserPerMin: 10,
    perChannelPerMin: 30,
    globalPerHour: 10,
    globalPerDay: 50,
  };
  const wake = new WakeHandoff({
    url: options.url || 'https://hooks.example/wake',
    key: options.key || 'test-webhook-key',
    allowedHosts: ['hooks.example'],
    maxBatch: 5,
    maxPerHour: 100,
    quietMs: 1500,
    maxFailedAttempts: options.maxFailedAttempts,
    now: () => clock,
    log: (entry) => log.info(entry),
    schedule: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clear: (timer) => { if (timer) timer.cleared = true; },
    fetchImpl: options.fetchImpl || (async ({ body }) => {
      posts.push(body);
      return { status: 200, bodyText: 'ok' };
    }),
  });
  const bridge = new Bridge({
    client: { user: { id: '444' } },
    config: enabledConfig({
      queue: { dir: path.join(root, 'queue'), requireOutboxSig: true },
      features: { enabled: true, killSwitchFile: path.join(root, 'STOP') },
      wake: { allowedHosts: ['hooks.example'], maxFailedAttempts: options.maxFailedAttempts },
      policy: { rateLimits: limits },
    }),
    queue: new FileQueue(path.join(root, 'queue')),
    log,
    wake,
    sleep: async () => {},
    now: () => clock,
    hmacKey: '',
    lock: false,
    rateLimits: new RateLimiter(limits),
    alerter: { send: async () => {} },
  });
  return {
    root,
    bridge,
    wake,
    posts,
    timers,
    log,
    stop: path.join(root, 'STOP'),
    setNow(value) { clock = value; },
    async fire() {
      const timer = timers.filter((item) => !item.cleared).at(-1);
      assert.ok(timer);
      await timer.fn();
      return timer;
    },
  };
}

function readyConfig(root) {
  const config = defaultConfig();
  config.features.enabled = true;
  config.features.killSwitchFile = path.join(root, 'STOP');
  config.discord.applicationId = '100000000000000999';
  config.discord.botUserId = '';
  config.discord.guildIds = ['100000000000000111'];
  config.discord.channelIds = ['100000000000000222'];
  config.discord.allowedUserIds = ['100000000000000333'];
  config.discord.allowedRoleIds = [];
  config.policy.usersOnly = true;
  config.policy.requireMention = true;
  config.wake.allowedHosts = ['hooks.example'];
  config.queue.dir = path.join(root, 'queue');
  config.queue.requireOutboxSig = true;
  config.logging.dir = path.join(root, 'logs');
  return config;
}

function webhookEnv(extra) {
  return {
    COMMS_WEBHOOK_URL: 'https://hooks.example/wake',
    COMMS_WEBHOOK_KEY: 'test-webhook-key',
    QUEUE_HMAC_KEY: KEY,
    ...extra,
  };
}

describe('hardening follow-ups', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('JC-42 drops an id after the failed-attempt cap and audits without the webhook url', async () => {
    let calls = 0;
    const ctx = liveWake(dirs, {
      maxFailedAttempts: 2,
      url: `https://hooks.example/${SECRET}`,
      fetchImpl: async () => {
        calls += 1;
        return { status: 503, bodyText: `down ${SECRET} Bearer test-webhook-key` };
      },
    });
    assert.equal(new WakeHandoff({ url: 'https://hooks.example/wake', key: 'k' }).maxFailedAttempts, 8);

    await ctx.wake.notify('9401');
    await ctx.fire();
    assert.equal(calls, 1);
    assert.ok(ctx.wake.pending.includes('9401'));
    assert.equal(ctx.log.entries.some((entry) => entry.reason === 'wake_abandoned'), false);

    await ctx.wake.notify('9402');
    await ctx.fire();
    assert.equal(calls, 2);
    assert.equal(ctx.wake.pending.includes('9401'), false);
    assert.ok(ctx.wake.pending.includes('9402'));
    const audits = ctx.log.entries.filter((entry) => entry.event === 'audit');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].reason, 'wake_abandoned');
    assert.equal(audits[0].messageId, '9401');
    assert.equal(audits[0].status, 503);
    assert.equal(audits[0].attempts, 2);
    const logged = JSON.stringify(ctx.log.entries);
    assert.equal(logged.includes(SECRET), false);
    assert.equal(logged.includes('test-webhook-key'), false);
    assert.equal(logged.includes('Bearer'), false);
    assert.equal(logged.includes('bodyText'), false);

    const again = await ctx.wake.notify('9401');
    assert.equal(again.abandoned, true);
    assert.equal(calls, 2);

    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
    assert.equal(example.wake.maxFailedAttempts, 8);
    assert.equal(example.features.enabled, false);
    assert.equal(defaultConfig().wake.maxFailedAttempts, 8);
    const clamped = defaultConfig();
    clamped.wake.maxFailedAttempts = 100;
    clampConfig(clamped);
    assert.equal(clamped.wake.maxFailedAttempts, 30);
    const root = tempDir('phicc-cap-');
    dirs.push(root);
    const high = loadConfig({
      root,
      examplePath: path.join(__dirname, '..', 'config.example.json'),
      env: { DBR_WAKE_MAXFAILEDATTEMPTS: '4' },
    });
    assert.equal(high.config.wake.maxFailedAttempts, 4);
    assert.equal(high.config.features.enabled, false);
  });

  it('JC-43 refuses startup when the alert webhook host is not allowlisted', () => {
    const root = tempDir('phicc-alert-');
    dirs.push(root);
    const config = readyConfig(root);
    const env = webhookEnv();
    assert.doesNotThrow(() => assertReady(config, {
      env: webhookEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example/alert' }),
    }));

    const badPath = `/${SECRET}`;
    const badUrl = `https://user:pw@other.example${badPath}?token=pw`;
    assert.throws(() => assertReady(config, {
      env: webhookEnv({ ALERT_WEBHOOK_URL: badUrl }),
    }), (err) => {
      assert.equal(err.code, 'ALERT_HOST');
      assert.equal(err.message, 'ALERT_HOST');
      assert.equal(err.message.includes(SECRET), false);
      assert.equal(err.message.includes('pw'), false);
      return true;
    });
    assert.throws(() => assertReady(config, {
      env: webhookEnv({ ALERT_WEBHOOK_URL: `http://hooks.example${badPath}` }),
    }), (err) => err.code === 'ALERT_HTTPS' && err.message === 'ALERT_HTTPS' && !err.message.includes(SECRET));
    assert.throws(() => assertReady(config, {
      env: webhookEnv({ ALERT_WEBHOOK_URL: 'not a url' }),
    }), (err) => err.code === 'ALERT_HTTPS' && !err.message.includes('not a url'));

    const off = defaultConfig();
    assert.equal(off.features.enabled, false);
    assert.doesNotThrow(() => assertReady(off, {
      env: { ALERT_WEBHOOK_URL: badUrl },
    }));

    const client = new EventEmitter();
    assert.throws(() => attachToClient(client, {
      autostart: false,
      lock: false,
      config,
      env: webhookEnv({ ALERT_WEBHOOK_URL: badUrl }),
      log: memoryLogger(),
      wake: { notify() {}, stop() {} },
    }), (err) => err.code === 'ALERT_HOST' && err.message === 'ALERT_HOST' && !err.message.includes(SECRET));
    assert.equal(client.listenerCount('messageCreate'), 0);
    assert.equal(env.ALERT_WEBHOOK_URL, undefined);
  });

  it('JC-44 honors requireOutboxSig false only from config.local.json', async () => {
    const exampleOnDisk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
    assert.equal(exampleOnDisk.queue.requireOutboxSig, true);
    assert.equal(exampleOnDisk.features.enabled, false);
    assert.equal(defaultConfig().queue.requireOutboxSig, true);

    const root = tempDir('phicc-sig-');
    dirs.push(root);
    const examplePath = path.join(root, 'config.example.json');
    const localPath = path.join(root, 'config.local.json');
    fs.writeFileSync(examplePath, JSON.stringify({
      queue: { requireOutboxSig: false },
      features: { enabled: false },
    }));
    fs.writeFileSync(localPath, JSON.stringify({
      discord: { guildIds: ['100000000000000111'] },
    }));
    fs.chmodSync(localPath, 0o600);
    const blocked = loadConfig({
      root,
      examplePath,
      localPath,
      env: { DBR_QUEUE_REQUIREOUTBOXSIG: 'false' },
    });
    assert.equal(blocked.config.queue.requireOutboxSig, true);
    assert.equal(blocked.config.features.enabled, false);

    fs.writeFileSync(localPath, JSON.stringify({
      queue: { requireOutboxSig: false, dir: path.join(root, 'queue') },
      features: { enabled: false, killSwitchFile: path.join(root, 'STOP') },
    }));
    const opened = loadConfig({
      root,
      examplePath,
      localPath,
      env: { DBR_QUEUE_REQUIREOUTBOXSIG: 'true' },
    });
    assert.equal(opened.config.queue.requireOutboxSig, false);
    assert.equal(opened.config.features.enabled, false);

    const queue = new FileQueue(path.join(root, 'queue'));
    const bridge = new Bridge({
      client: { user: { id: '444' } },
      config: enabledConfig({
        queue: { dir: path.join(root, 'queue'), requireOutboxSig: opened.config.queue.requireOutboxSig },
        features: { enabled: true, killSwitchFile: path.join(root, 'STOP') },
      }),
      queue,
      log: memoryLogger(),
      wake: { notify: async () => {}, stop() {} },
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      hmacKey: KEY,
      lock: false,
      alerter: { send: async () => {} },
    });
    const calls = [];
    await bridge.handleMessage(mention('9501'));
    queue.overwrite('outbox', '9501', {
      replyTo: '9501',
      channelId: '222',
      text: 'plain reply',
      final: true,
    });
    bridge.resolveMessage = async () => fakeMessage({
      id: '9501',
      username: 'user',
      displayName: 'User',
      reply: async (payload) => { calls.push(payload.content); },
    });
    const sent = await bridge.flushOutbox();
    assert.equal(sent[0].done, true);
    assert.equal(calls[0], 'plain reply');
  });

  it('JC-52 sends prepaid mentions and defers only re-wakes that do not fit', async () => {
    const ctx = liveWake(dirs, {
      rateLimits: {
        perUserPerMin: 10,
        perChannelPerMin: 30,
        globalPerHour: 2,
        globalPerDay: 50,
      },
    });
    await ctx.bridge.handleMessage(mention('9101'));
    await ctx.fire();
    assert.deepEqual(ctx.posts[0], { msgId: '9101' });
    assert.equal(ctx.bridge.prepaid.has('9101'), false);

    await ctx.bridge.requestRewake('9101');
    await ctx.bridge.handleMessage(mention('9102'));
    assert.equal(ctx.bridge.prepaid.has('9102'), true);
    assert.deepEqual(ctx.wake.pending.slice(), ['9101', '9102']);
    const before = ctx.posts.length;
    await ctx.fire();
    assert.equal(ctx.posts.length, before + 1);
    assert.deepEqual(ctx.posts.at(-1), { msgId: '9102' });
    assert.deepEqual(ctx.wake.pending.slice(), ['9101']);
    assert.equal(ctx.bridge.rates.snapshot().global.length, 2);
    assert.equal(ctx.bridge.prepaid.has('9102'), false);
    assert.equal(ctx.bridge.rewakeQueued.has('9101'), true);
    assert.equal(fs.existsSync(ctx.stop), false);
    const deferred = ctx.timers.filter((timer) => !timer.cleared).at(-1);
    assert.ok(deferred.ms >= 60 * 1000);

    const mixed = liveWake(dirs, {
      rateLimits: {
        perUserPerMin: 10,
        perChannelPerMin: 30,
        globalPerHour: 4,
        globalPerDay: 50,
      },
    });
    await mixed.bridge.handleMessage(mention('9111'));
    await mixed.fire();
    await mixed.bridge.handleMessage(mention('9112'));
    await mixed.fire();
    await mixed.bridge.requestRewake('9111');
    await mixed.bridge.requestRewake('9112');
    await mixed.bridge.handleMessage(mention('9113'));
    await mixed.fire();
    assert.deepEqual(mixed.posts.at(-1), { msgIds: ['9111', '9113'] });
    assert.deepEqual(mixed.wake.pending.slice(), ['9112']);
    assert.equal(mixed.bridge.rates.snapshot().global.length, 4);
    assert.equal(mixed.bridge.rewakeQueued.has('9111'), false);
    assert.equal(mixed.bridge.rewakeQueued.has('9112'), true);
    assert.equal(fs.existsSync(mixed.stop), false);
  });

  it('JC-53 clears rewake tracking on STOP and when a prepaid wake is charged', async () => {
    const billed = liveWake(dirs);
    await billed.bridge.handleMessage(mention('9201'));
    assert.equal(billed.bridge.prepaid.has('9201'), true);
    assert.equal(await billed.bridge.requestRewake('9201'), true);
    assert.equal(billed.bridge.rewakeQueued.has('9201'), true);
    await billed.fire();
    assert.equal(billed.bridge.prepaid.has('9201'), false);
    assert.equal(billed.bridge.rewakeQueued.has('9201'), false);
    assert.equal(billed.bridge.rates.snapshot().global.length, 1);
    assert.equal(await billed.bridge.requestRewake('9201'), true);

    const ctx = liveWake(dirs);
    await ctx.bridge.handleMessage(mention('9301'));
    await ctx.fire();
    await ctx.bridge.requestRewake('9301');
    await ctx.bridge.handleMessage(mention('9302'));
    assert.equal(ctx.bridge.rewakeQueued.has('9301'), true);
    assert.equal(ctx.bridge.prepaid.has('9302'), true);
    assert.deepEqual(ctx.wake.pending.slice().sort(), ['9301', '9302']);
    const posted = ctx.posts.length;
    fs.writeFileSync(ctx.stop, 'stop\n');
    const skipped = await ctx.bridge.flushOutbox();
    assert.equal(skipped.skipped, true);
    assert.deepEqual(ctx.wake.pending, []);
    assert.equal(ctx.posts.length, posted);
    assert.equal(ctx.bridge.rewakeQueued.has('9301'), false);
    assert.equal(ctx.bridge.prepaid.has('9302'), false);
    assert.equal(await ctx.bridge.requestRewake('9303'), false);
    assert.equal(ctx.bridge.rewakeQueued.has('9303'), false);
    fs.unlinkSync(ctx.stop);
    assert.equal(await ctx.bridge.requestRewake('9301'), true);
    assert.equal(await ctx.bridge.requestRewake('9302'), true);
    assert.ok(ctx.wake.pending.includes('9301'));
    assert.ok(ctx.wake.pending.includes('9302'));
  });
});
