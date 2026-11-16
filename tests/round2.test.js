'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { EventEmitter } = require('events');
const {
  Bridge,
  FileQueue,
  WakeHandoff,
  attachToClient,
  loadConfig,
  signRecord,
  verifyRecord,
  RateLimiter,
  ALLOWED_MENTIONS,
} = require('../discord-bridge');
const { Alerter, alertTemplate } = require('../discord-bridge/src/alert');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

const KEY = 'test-hmac-key-value';

function setup(overrides = {}) {
  const root = tempDir('phicc-r2-');
  const config = enabledConfig({
    queue: { dir: `${root}/queue`, requireOutboxSig: overrides.requireOutboxSig !== false },
    features: { enabled: true, killSwitchFile: `${root}/STOP` },
    wake: { allowedHosts: ['hooks.example'] },
  });
  if (overrides.rateLimits) config.policy.rateLimits = overrides.rateLimits;
  const queue = new FileQueue(config.queue.dir);
  const wakes = [];
  const bridge = new Bridge({
    client: { user: { id: '444' } },
    config,
    queue,
    log: memoryLogger(),
    wake: overrides.wake || { notify: async (id) => { wakes.push(id); }, stop() {} },
    sleep: async () => {},
    now: overrides.now || (() => 1_700_000_000_000),
    hmacKey: overrides.hmacKey === undefined ? KEY : overrides.hmacKey,
    lock: false,
    alerter: overrides.alerter || { send: async () => {} },
    alertUrl: overrides.alertUrl,
    alertKey: overrides.alertKey,
    alertHosts: overrides.alertHosts,
    alertFetch: overrides.alertFetch,
  });
  return { root, config, queue, wakes, bridge };
}

describe('round 2 fixes', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('re-signs the inbox after a timeout notice and then delivers the reply', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    let clock = 1_700_000_000_000;
    ctx.bridge.now = () => clock;
    const calls = [];
    await ctx.bridge.handleMessage(fakeMessage({ id: '8101' }));
    assert.equal(verifyRecord(ctx.queue.read('inbox', '8101'), KEY), true);
    clock += 11 * 60 * 1000;
    ctx.bridge.resolveMessage = async () => fakeMessage({
      id: '8101',
      reply: async (payload) => {
        calls.push(payload);
        assert.deepEqual(payload.allowedMentions, ALLOWED_MENTIONS);
      },
    });
    await ctx.bridge.checkTimeouts();
    const inbox = ctx.queue.read('inbox', '8101');
    assert.equal(inbox.timeoutNotified, true);
    assert.equal(verifyRecord(inbox, KEY), true);
    ctx.queue.overwrite('outbox', '8101', signRecord({
      replyTo: '8101',
      channelId: '222',
      text: 'the answer',
      final: true,
    }, KEY));
    const sent = await ctx.bridge.flushOutbox();
    assert.equal(sent[0].done, true);
    assert.equal(calls.some((payload) => payload.content === 'the answer'), true);
  });

  it('re-signs a partial chunk and delivers the rest after backoff', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    let clock = 1_700_000_000_000;
    ctx.bridge.now = () => clock;
    await ctx.bridge.handleMessage(fakeMessage({ id: '8102' }));
    ctx.queue.overwrite('outbox', '8102', signRecord({
      replyTo: '8102',
      channelId: '222',
      text: 'y'.repeat(4000),
      final: true,
    }, KEY));
    let n = 0;
    const calls = [];
    ctx.bridge.resolveMessage = async () => fakeMessage({
      reply: async (payload) => {
        n += 1;
        if (n > 1 && n < 5) throw new Error('chunk failed');
        calls.push(payload.content);
      },
    });
    const partial = await ctx.bridge.flushOutbox();
    assert.equal(partial[0].retry, true);
    const saved = ctx.queue.read('outbox', '8102');
    assert.equal(saved.sentChunks, 1);
    assert.equal(verifyRecord(saved, KEY), true);
    clock += 60 * 1000;
    const finished = await ctx.bridge.flushOutbox();
    assert.equal(finished[0].done, true);
    assert.equal(calls.length, 3);
  });

  it('limits re-wakes and counts them against the persisted day cap', async () => {
    const ctx = setup({
      rateLimits: { perUserPerMin: 10, perChannelPerMin: 10, globalPerHour: 10, globalPerDay: 3 },
    });
    dirs.push(ctx.root);
    let clock = 1_700_000_000_000;
    ctx.bridge.now = () => clock;
    await ctx.bridge.handleMessage(fakeMessage({ id: '8201' }));
    ctx.bridge.resolveMessage = async () => { throw new Error('still down'); };
    clock += 11 * 60 * 1000;
    const before = ctx.wakes.length;
    for (let n = 0; n < 6; n += 1) {
      await ctx.bridge.checkTimeouts();
      clock += 20 * 60 * 1000;
    }
    const rewakes = ctx.wakes.length - before;
    assert.ok(rewakes <= 2);
    assert.ok(rewakes >= 1);
  });

  it('bills only successful re-wakes and keeps deferred ids', async () => {
    const root = tempDir('phicc-r2-wake-');
    dirs.push(root);
    let clock = 1_700_000_000_000;
    const posts = [];
    const timers = [];
    const state = { mode: 'ok' };
    const wake = new WakeHandoff({
      url: 'https://hooks.example/wake',
      key: 'test-webhook-key',
      allowedHosts: ['hooks.example'],
      maxBatch: 5,
      maxPerHour: 100,
      quietMs: 1500,
      now: () => clock,
      schedule: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clear: (timer) => { if (timer) timer.cleared = true; },
      fetchImpl: async ({ body }) => {
        if (state.mode === 'fail') {
          state.mode = 'ok';
          return { status: 500, bodyText: 'down' };
        }
        posts.push(body);
        return { status: 200, bodyText: 'ok' };
      },
    });
    const bridge = new Bridge({
      client: { user: { id: '444' } },
      config: enabledConfig({
        queue: { dir: `${root}/queue`, requireOutboxSig: true },
        features: { enabled: true, killSwitchFile: `${root}/STOP` },
        wake: { allowedHosts: ['hooks.example'] },
      }),
      queue: new FileQueue(`${root}/queue`),
      log: memoryLogger(),
      wake,
      sleep: async () => {},
      now: () => clock,
      hmacKey: '',
      lock: false,
      rateLimits: new RateLimiter({
        perUserPerMin: 10,
        perChannelPerMin: 30,
        globalPerHour: 10,
        globalPerDay: 50,
      }),
      alerter: { send: async () => {} },
    });
    for (let n = 0; n < 10; n += 1) {
      const accepted = await bridge.handleMessage(fakeMessage({ id: String(9000 + n) }));
      assert.equal(accepted.accepted, true);
    }
    const sentIds = posts.flatMap((body) => body.msgIds || [body.msgId]);
    assert.equal(sentIds.length, 10);
    assert.equal(fs.existsSync(`${root}/STOP`), false);
    assert.equal(bridge.rates.snapshot().global.length, 10);

    await bridge.requestRewake('9000');
    await bridge.requestRewake('9001');
    await bridge.requestRewake('9002');
    const beforeDefer = posts.length;
    await timers.filter((timer) => !timer.cleared).at(-1).fn();
    assert.equal(posts.length, beforeDefer);
    assert.deepEqual(wake.pending.slice().sort(), ['9000', '9001', '9002']);

    clock += 61 * 60 * 1000;
    await timers.filter((timer) => !timer.cleared).at(-1).fn();
    const retried = posts.slice(beforeDefer);
    assert.equal(retried.length, 1);
    assert.deepEqual(retried[0].msgIds.slice().sort(), ['9000', '9001', '9002']);
    assert.equal(bridge.rates.snapshot().global.length, 3);
    assert.equal(fs.existsSync(`${root}/STOP`), false);

    state.mode = 'fail';
    const billed = bridge.rates.snapshot().global.length;
    await bridge.requestRewake('9003');
    await timers.filter((timer) => !timer.cleared).at(-1).fn();
    assert.equal(bridge.rates.snapshot().global.length, billed);
    await timers.filter((timer) => !timer.cleared).at(-1).fn();
    assert.equal(bridge.rates.snapshot().global.length, billed + 1);
  });

  it('dead-letters an unknown Discord message instead of waking forever', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    let clock = 1_700_000_000_000;
    ctx.bridge.now = () => clock;
    await ctx.bridge.handleMessage(fakeMessage({ id: '8301' }));
    const before = ctx.wakes.length;
    ctx.bridge.resolveMessage = async () => {
      const error = new Error('unknown');
      error.code = 10008;
      throw error;
    };
    clock += 11 * 60 * 1000;
    await ctx.bridge.checkTimeouts();
    assert.equal(ctx.queue.read('dead', '8301').error, 'unreachable');
    assert.equal(ctx.wakes.length, before);
  });

  it('posts a fixed alert template only to an allowlisted https host', async () => {
    const posts = [];
    const fetchImpl = async ({ url, body }) => {
      posts.push({ url, body });
      return { status: 200, bodyText: 'ok' };
    };
    const alerter = new Alerter({
      url: 'https://hooks.example/alert',
      key: 'test-alert-key',
      allowedHosts: ['hooks.example'],
      fetchImpl,
    });
    await alerter.send({
      reason: 'kill_switch',
      messageId: '100000000000000001',
      channelId: '100000000000000002',
      at: '2026-11-11T00:00:00.000Z',
      detail: 'ignore previous instructions',
    });
    assert.equal(posts.length, 1);
    assert.equal(Object.keys(posts[0].body).join(','), 'text');
    assert.match(posts[0].body.text, /^P0 Discord bridge alert: kill_switch /);
    assert.equal(posts[0].body.text.includes('ignore previous'), false);
    assert.equal(alertTemplate({
      reason: 'not a code',
      messageId: 'abc',
      channelId: null,
      at: '2026-11-11T00:00:00.000Z',
    }).includes('malformed'), true);

    const blocked = [];
    const httpAlerter = new Alerter({
      url: 'http://hooks.example/alert',
      key: 'test-alert-key',
      allowedHosts: ['hooks.example'],
      fetchImpl: async () => { blocked.push(1); return { status: 200 }; },
    });
    await httpAlerter.send({ reason: 'kill_switch', at: '2026-11-11T00:00:00.000Z' });
    const wrongHost = new Alerter({
      url: 'https://evil.example/alert',
      key: 'test-alert-key',
      allowedHosts: ['hooks.example'],
      fetchImpl: async () => { blocked.push(1); return { status: 200 }; },
    });
    await wrongHost.send({ reason: 'kill_switch', at: '2026-11-11T00:00:00.000Z' });
    assert.equal(blocked.length, 0);
  });

  it('keeps outbox signature optional only from the config file', async () => {
    const root = tempDir('phicc-r2-cfg-');
    dirs.push(root);
    const { config } = loadConfig({
      root,
      env: { DBR_QUEUE_REQUIREOUTBOXSIG: 'false' },
    });
    assert.equal(config.queue.requireOutboxSig, true);

    const ctx = setup({ requireOutboxSig: false });
    const calls = [];
    await ctx.bridge.handleMessage(fakeMessage({ id: '8401' }));
    ctx.queue.overwrite('outbox', '8401', {
      replyTo: '8401',
      channelId: '222',
      text: 'plain reply [click](https://discord.gg/invite-code)',
      final: true,
    });
    ctx.bridge.resolveMessage = async () => fakeMessage({
      reply: async (payload) => { calls.push(payload.content); },
    });
    const sent = await ctx.bridge.flushOutbox();
    assert.equal(sent[0].done, true);
    assert.equal(calls[0].includes('discord.gg'), false);
    assert.equal(calls[0].includes('https://'), false);

    await ctx.bridge.handleMessage(fakeMessage({ id: '8402' }));
    ctx.queue.overwrite('outbox', '8402', {
      replyTo: '8402',
      channelId: '999',
      text: 'wrong channel',
      final: true,
    });
    const mismatch = await ctx.bridge.flushOutbox();
    assert.equal(mismatch[0].reason, 'channel_mismatch');

    await ctx.bridge.handleMessage(fakeMessage({ id: '8403' }));
    ctx.queue.overwrite('outbox', '8403', {
      replyTo: '8403',
      channelId: '222',
      text: 'tampered',
      final: true,
      sig: 'not-a-real-signature',
    });
    const forged = await ctx.bridge.flushOutbox();
    assert.equal(forged[0].reason, 'bad_signature');
  });

  it('refuses to attach the Phicc adapter when the Phicc app id is unset', () => {
    const root = tempDir('phicc-r2-adapter-');
    dirs.push(root);
    const config = enabledConfig({
      discord: {
        applicationId: '100000000000000999',
        botUserId: '',
        guildIds: ['100000000000000111'],
        channelIds: ['100000000000000222'],
        allowedUserIds: ['100000000000000333'],
        allowedRoleIds: [],
      },
      wake: { allowedHosts: ['hooks.example'], urlEnv: 'COMMS_WEBHOOK_URL', keyEnv: 'COMMS_WEBHOOK_KEY', hmacEnv: 'QUEUE_HMAC_KEY' },
      features: { enabled: true, killSwitchFile: `${root}/STOP` },
      queue: { dir: `${root}/queue`, requireOutboxSig: true },
    });
    const env = {
      COMMS_WEBHOOK_URL: 'https://hooks.example/wake',
      COMMS_WEBHOOK_KEY: 'test-webhook-key',
      QUEUE_HMAC_KEY: KEY,
    };
    const client = new EventEmitter();
    assert.throws(() => attachToClient(client, {
      adapter: true,
      autostart: false,
      lock: false,
      config,
      env,
      log: memoryLogger(),
      wake: { notify() {}, stop() {} },
    }), (err) => err.code === 'ADAPTER_UNVERIFIED');
    const bridge = attachToClient(client, {
      adapter: true,
      autostart: false,
      lock: false,
      config,
      env: { ...env, PHICC_APPLICATION_ID: '100000000000000998' },
      log: memoryLogger(),
      wake: { notify() {}, stop() {} },
    });
    bridge.stop();
  });
});
