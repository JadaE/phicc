'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { trackGateway, attachToClient } = require('../discord-bridge');
const { GatewayMonitor, checkHeartbeatFile } = require('../discord-bridge/src/liveness');
const { Backfill } = require('../discord-bridge/src/backfill');
const { main } = require('../discord-bridge/standalone');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

const T0 = 1_700_000_000_000;
const IDS = {
  guild: '100000000000000111',
  channel: '100000000000000222',
  user: '100000000000000333',
  bot: '100000000000000444',
  app: '100000000000000999',
};

function realConfig(root) {
  const config = enabledConfig({
    queue: { dir: `${root}/queue`, requireOutboxSig: true },
    features: { enabled: true, killSwitchFile: `${root}/STOP` },
    logging: { level: 'info', dir: `${root}/logs`, logBodies: false },
    wake: { allowedHosts: ['hooks.example'] },
  });
  config.discord.guildIds = [IDS.guild];
  config.discord.channelIds = [IDS.channel];
  config.discord.allowedUserIds = [IDS.user];
  config.discord.allowedRoleIds = [];
  config.discord.applicationId = IDS.app;
  config.discord.botUserId = IDS.bot;
  return config;
}

function realMessage(id) {
  return fakeMessage({
    id, botId: IDS.bot, userId: IDS.user, channelId: IDS.channel, guildId: IDS.guild, createdTimestamp: Date.now(),
  });
}

function fakeClient(status = 0) {
  const client = new EventEmitter();
  client.ws = { status, ping: 42 };
  return client;
}

function manualTimers() {
  const timers = [];
  return {
    setInterval: (fn) => { timers.push(fn); return { unref() {} }; },
    clearInterval: () => { timers.length = 0; },
    fire: () => timers.forEach((fn) => fn()),
  };
}

describe('gateway lifecycle logging', () => {
  it('logs disconnect codes, reconnecting, shard errors and invalidated without text', () => {
    const client = new EventEmitter();
    const log = memoryLogger();
    trackGateway(client, log, { identifies: [] });
    client.emit('shardDisconnect', { code: 4009, reason: 'secret reason' }, 0);
    client.emit('shardReconnecting', 0);
    const err = new Error('boom token-ish text');
    err.code = 'ECONNRESET';
    client.emit('shardError', err, 0);
    client.emit('warn', 'some warning text');
    client.emit('shardResume', 0, 3);
    const events = log.entries.map((e) => e.event);
    for (const name of ['gateway_disconnect', 'gateway_reconnecting', 'gateway_shard_error', 'gateway_warn', 'gateway_resume']) {
      assert.ok(events.includes(name), name);
    }
    assert.equal(log.entries.find((e) => e.event === 'gateway_disconnect').closeCode, 4009);
    assert.equal(log.entries.find((e) => e.event === 'gateway_resume').replayed, 3);
    const text = JSON.stringify(log.entries);
    assert.equal(text.includes('secret reason'), false);
    assert.equal(text.includes('boom'), false);
    assert.equal(text.includes('some warning text'), false);
  });
});

describe('gateway liveness monitor', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  function setup(status = 0) {
    const dir = tempDir('phicc-live-');
    dirs.push(dir);
    let clock = T0;
    const client = fakeClient(status);
    const timers = manualTimers();
    const stale = [];
    const log = memoryLogger();
    const monitor = new GatewayMonitor({
      client,
      log,
      heartbeatFile: path.join(dir, 'heartbeat.json'),
      now: () => clock,
      onStale: (reason) => stale.push(reason),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    }).start();
    return {
      dir, client, monitor, stale, log, timers,
      file: path.join(dir, 'heartbeat.json'),
      advance(ms) { clock += ms; },
      now: () => clock,
    };
  }

  it('stays healthy while heartbeat ACKs (raw packets) keep arriving', () => {
    const ctx = setup();
    for (let n = 0; n < 20; n += 1) {
      ctx.advance(15000);
      if (n % 3 === 0) ctx.client.emit('raw', { op: 11 });
      ctx.timers.fire();
    }
    assert.deepEqual(ctx.stale, []);
    const snap = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    assert.equal(snap.healthy, true);
    assert.equal(snap.statusName, 'READY');
    assert.equal(snap.ping, 42);
    assert.equal((fs.statSync(ctx.file).mode & 0o777), 0o600);
    assert.equal(checkHeartbeatFile(ctx.file, { now: ctx.now() }).ok, true);
  });

  it('trips once when no gateway packet arrives for 150 s (zombie connection)', () => {
    const ctx = setup();
    ctx.client.emit('raw', { op: 11 });
    for (let n = 0; n < 12; n += 1) { ctx.advance(15000); ctx.timers.fire(); }
    assert.deepEqual(ctx.stale, ['no_gateway_packets']);
    const snap = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    assert.equal(snap.healthy, false);
    assert.equal(checkHeartbeatFile(ctx.file, { now: ctx.now() }).ok, false);
    assert.ok(ctx.log.entries.some((e) => e.event === 'gateway_stale' && e.reason === 'no_gateway_packets'));
  });

  it('trips when the shard is not READY for more than 3 minutes even with packets', () => {
    const ctx = setup(2);
    for (let n = 0; n < 14; n += 1) { ctx.advance(15000); ctx.client.emit('raw', { op: 11 }); ctx.timers.fire(); }
    assert.deepEqual(ctx.stale, ['not_ready']);
  });

  it('trips right away after the box was paused (late timer tick)', () => {
    const ctx = setup();
    ctx.client.emit('raw', { op: 11 });
    ctx.advance(15000); ctx.timers.fire();
    ctx.advance(14 * 60 * 60 * 1000); ctx.timers.fire();
    assert.deepEqual(ctx.stale, ['sleep_gap']);
  });

  it('trips on invalidated', () => {
    const ctx = setup();
    ctx.client.emit('invalidated');
    assert.deepEqual(ctx.stale, ['invalidated']);
    assert.ok(ctx.log.entries.some((e) => e.event === 'gateway_invalidated'));
  });
});

describe('watchdog heartbeat check', () => {
  const dir = tempDir('phicc-hb-');
  after(() => rmrf(dir));
  const file = path.join(dir, 'heartbeat.json');
  const write = (snap) => fs.writeFileSync(file, JSON.stringify(snap));

  it('flags a missing, stale or never-connected heartbeat', () => {
    assert.equal(checkHeartbeatFile(path.join(dir, 'nope.json')).reason, 'missing');
    write({ ts: T0, startedAt: T0, lastPacketAt: T0, healthy: true, statusName: 'READY' });
    assert.equal(checkHeartbeatFile(file, { now: T0 + 30000 }).ok, true);
    assert.equal(checkHeartbeatFile(file, { now: T0 + 130000 }).reason, 'file_stale');
    write({ ts: T0 + 200000, startedAt: T0, lastPacketAt: T0, healthy: true });
    assert.equal(checkHeartbeatFile(file, { now: T0 + 200000 }).reason, 'gateway_stale');
    write({ ts: T0 + 200000, startedAt: T0, lastPacketAt: null, healthy: true });
    assert.equal(checkHeartbeatFile(file, { now: T0 + 200000 }).reason, 'never_connected');
    write({ ts: T0, startedAt: T0, lastPacketAt: null, healthy: true });
    assert.equal(checkHeartbeatFile(file, { now: T0 + 1000 }).ok, true);
    write({ ts: T0, startedAt: T0, lastPacketAt: T0, healthy: false, reason: 'sleep_gap' });
    assert.equal(checkHeartbeatFile(file, { now: T0 }).reason, 'sleep_gap');
  });
});

function collection(list) {
  const map = new Map(list.map((m) => [m.id, m]));
  map.first = () => list[0];
  return map;
}

function fakeChannel(messages) {
  const calls = [];
  return {
    calls,
    messages: {
      fetch: async (opts) => {
        calls.push(opts);
        if (!opts.after) return collection(messages.slice(-1));
        const after = BigInt(opts.after);
        const newer = messages.filter((m) => BigInt(m.id) > after).slice(0, opts.limit);
        return collection(newer.reverse());
      },
    },
  };
}

describe('backfill after reconnect', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  function setup(messages, options = {}) {
    const dir = tempDir('phicc-bf-');
    dirs.push(dir);
    const channel = fakeChannel(messages);
    const handled = [];
    const log = memoryLogger();
    const backfill = new Backfill({
      client: { channels: { fetch: async () => channel } },
      log,
      handle: options.handle || (async (m) => { handled.push(m.id); return { accepted: true }; }),
      channelIds: ['100000000000000222'],
      cursorFile: path.join(dir, 'state', 'cursor.json'),
      botId: () => '444',
      rateCheck: options.rateCheck,
      now: () => options.now || T0,
      schedule: () => null,
    });
    return { dir, channel, handled, log, backfill };
  }

  const msg = (id, extra = {}) => fakeMessage({ id, channelId: '100000000000000222', createdTimestamp: T0 - 60000, ...extra });

  it('seeds the cursor on first run without replaying old history', async () => {
    const ctx = setup([msg('100000000000001001')]);
    await ctx.backfill.trigger('connected');
    assert.deepEqual(ctx.handled, []);
    assert.equal(ctx.backfill.cursor['100000000000000222'], '100000000000001001');
  });

  it('hands missed mentions to the normal handler in order and skips others', async () => {
    const messages = [
      msg('100000000000001001'),
      msg('100000000000001002'),
      msg('100000000000001003', { mention: false, content: 'no ping' }),
      msg('100000000000001004', { bot: true }),
      msg('100000000000001005', { createdTimestamp: T0 - 13 * 60 * 60 * 1000 }),
      msg('100000000000001006'),
    ];
    const ctx = setup(messages);
    ctx.backfill.note(messages[0]);
    const summary = await ctx.backfill.trigger('connected');
    assert.deepEqual(ctx.handled, ['100000000000001002', '100000000000001006']);
    assert.equal(summary.skippedOld, 1);
    assert.equal(ctx.backfill.cursor['100000000000000222'], '100000000000001006');
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'state', 'cursor.json'), 'utf8'));
    assert.equal(saved.channels['100000000000000222'], '100000000000001006');
    assert.equal(JSON.stringify(ctx.log.entries).includes('hello'), false);
  });

  it('stops before a rate limit instead of tripping the kill switch, and keeps the cursor', async () => {
    const messages = [msg('100000000000001001'), msg('100000000000001002'), msg('100000000000001003')];
    let budget = 1;
    const ctx = setup(messages, {
      rateCheck: () => (budget-- > 0 ? { ok: true } : { ok: false, reason: 'rate_limited_global' }),
    });
    ctx.backfill.note(messages[0]);
    const summary = await ctx.backfill.trigger('connected');
    assert.equal(summary.deferred, true);
    assert.deepEqual(ctx.handled, ['100000000000001002']);
    assert.equal(ctx.backfill.cursor['100000000000000222'], '100000000000001002');
  });

  it('ignores channels that are not allowlisted when noting live messages', () => {
    const ctx = setup([]);
    ctx.backfill.note(fakeMessage({ id: '100000000000009999', channelId: '100000000000000777' }));
    assert.deepEqual(ctx.backfill.cursor, {});
  });
});

describe('attachToClient with backfill and liveness', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('queues a mention it missed while disconnected, once', async () => {
    const root = tempDir('phicc-attach-bf-');
    dirs.push(root);
    const config = realConfig(root);
    const live = realMessage('100000000000001001');
    const missed = realMessage('100000000000001002');
    const channel = fakeChannel([live, missed]);
    const client = fakeClient(0);
    client.user = { id: IDS.bot };
    client.channels = { fetch: async () => channel };
    const wakes = [];
    const timers = manualTimers();
    const bridge = attachToClient(client, {
      config,
      autostart: false,
      lock: false,
      env: { QUEUE_HMAC_KEY: 'test-hmac-key-value', COMMS_WEBHOOK_URL: 'https://hooks.example/wake', COMMS_WEBHOOK_KEY: 'test-webhook-key' },
      log: memoryLogger(),
      wake: { notify: async (id) => { wakes.push(id); }, stop() {} },
      alerter: { send: async () => {} },
      backfill: true,
      liveness: { heartbeatFile: `${root}/logs/heartbeat.json`, setInterval: timers.setInterval, clearInterval: timers.clearInterval },
    });
    await bridge.listener(live);
    client.emit('ready');
    await bridge.backfill.running;
    client.emit('shardResume', 0, 0);
    await bridge.backfill.running;
    assert.deepEqual(wakes, ['100000000000001001', '100000000000001002']);
    assert.ok(fs.existsSync(`${root}/logs/heartbeat.json`));
    bridge.detach();
  });
});

describe('standalone exits for the supervisor when the gateway is stale', () => {
  it('detaches, destroys the client, and exits 75', async () => {
    const root = tempDir('phicc-standalone-');
    const config = realConfig(root);
    config.discord.tokenEnv = 'DBR_TEST_FAKE_TOKEN';
    const saved = {};
    const testEnv = {
      DBR_TEST_FAKE_TOKEN: 'not-a-real-token',
      COMMS_WEBHOOK_URL: 'https://hooks.example/wake',
      COMMS_WEBHOOK_KEY: 'test-webhook-key',
      QUEUE_HMAC_KEY: 'test-hmac-key-value',
    };
    for (const [k, v] of Object.entries(testEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
    let destroyed = false;
    class Client extends EventEmitter {
      constructor() { super(); this.ws = { status: 0, ping: 1 }; }
      login() { return Promise.resolve(); }
      destroy() { destroyed = true; }
    }
    const codes = [];
    const result = main({
      config,
      discord: { Client },
      exit: (code) => codes.push(code),
      exitDelayMs: 1,
      liveness: { setInterval: () => ({ unref() {} }), clearInterval() {} },
    });
    assert.equal(result.started, true);
    result.onStale('no_gateway_packets');
    result.onStale('no_gateway_packets');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(destroyed, true);
    assert.deepEqual(codes, [75]);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmrf(root);
  });
});
