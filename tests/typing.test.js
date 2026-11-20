'use strict';

const { describe, it, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Bridge, FileQueue, clampConfig, defaultConfig } = require('../discord-bridge');
const {
  TYPING_INTERVAL_DEFAULT,
  TYPING_INTERVAL_MIN,
  TYPING_INTERVAL_MAX,
  TYPING_CAP_DEFAULT,
  TYPING_CAP_MIN,
  TYPING_CAP_MAX,
} = require('../discord-bridge/src/config');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

function advance(ms, step = 8000) {
  let left = ms;
  while (left > 0) {
    const slice = Math.min(step, left);
    mock.timers.tick(slice);
    left -= slice;
  }
}

function setup(overrides = {}) {
  const root = tempDir('phicc-typing-');
  const stop = path.join(root, 'STOP');
  const config = enabledConfig({
    queue: { dir: path.join(root, 'queue') },
    features: { enabled: true, killSwitchFile: stop },
    policy: {
      reactions: { ack: '👀', done: '✅', fail: '❌', enabled: true },
      typingIntervalMs: TYPING_INTERVAL_DEFAULT,
      typingCapMs: TYPING_CAP_DEFAULT,
      rateLimits: { perUserPerMin: 10, perChannelPerMin: 10, globalPerHour: 30, globalPerDay: 50 },
      ...(overrides.policy || {}),
    },
  });
  const queue = new FileQueue(config.queue.dir);
  const log = memoryLogger();
  const wakes = [];
  const bridge = new Bridge({
    client: { user: { id: '444' } },
    config,
    queue,
    log,
    wake: {
      notify: async (id) => { wakes.push(id); },
      stop() {},
    },
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    resolveMessage: overrides.resolveMessage,
  });
  return { root, stop, config, queue, log, wakes, bridge };
}

function typingMessage(id, sendTyping, extra = {}) {
  const channelId = extra.channelId || '222';
  return fakeMessage({
    ...extra,
    id,
    channelId,
    channel: {
      id: channelId,
      parentId: extra.parentId || null,
      isThread: () => Boolean(extra.thread),
      sendTyping,
    },
  });
}

describe('typing indicator', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });
  afterEach(() => { mock.timers.reset(); });

  it('starts on an accepted mention, refreshes at 8s, and does not duplicate the timer', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = typingMessage('6001', () => {
      calls.push('6001');
      return Promise.resolve();
    });
    const accepted = await ctx.bridge.handleMessage(message);
    assert.equal(accepted.accepted, true);
    assert.equal(ctx.bridge.intervalMs, 1000);
    assert.equal(calls.length, 1);
    assert.equal(ctx.bridge.typing.size, 1);

    advance(7999);
    assert.equal(calls.length, 1);
    advance(1);
    assert.deepEqual(calls, ['6001', '6001']);

    advance(4000);
    const duplicate = await ctx.bridge.handleMessage(message);
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(ctx.bridge.typing.size, 1);
    advance(4000);
    assert.equal(calls.length, 3);
    assert.equal(ctx.wakes.length, 1);
  });

  it('stops typing when the reply is sent and leaves another mention running', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const first = typingMessage('6201', () => {
      calls.push('6201');
      return Promise.resolve();
    }, {
      reply: async () => ({ id: 'r6201' }),
    });
    const second = typingMessage('6202', () => {
      calls.push('6202');
      return Promise.resolve();
    }, {
      userId: '333',
      content: '<@444> second',
    });
    assert.equal((await ctx.bridge.handleMessage(first)).accepted, true);
    assert.equal((await ctx.bridge.handleMessage(second)).accepted, true);
    assert.equal(ctx.bridge.typing.size, 2);

    ctx.queue.overwrite('outbox', '6201', {
      replyTo: '6201',
      channelId: '222',
      text: 'answer',
      final: true,
    });
    ctx.bridge.resolveMessage = async (_client, _channelId, id) => (id === '6201' ? first : second);
    const results = await ctx.bridge.flushOutbox();
    assert.equal(results[0].done, true);
    assert.equal(ctx.bridge.typing.has('6201'), false);
    assert.equal(ctx.bridge.typing.has('6202'), true);

    const before = calls.filter((id) => id === '6201').length;
    advance(16000);
    assert.equal(calls.filter((id) => id === '6201').length, before);
    assert.ok(calls.filter((id) => id === '6202').length > before);
    assert.equal(ctx.bridge.typing.size, 1);
  });

  it('stops typing when the reply is dead-lettered', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = typingMessage('6301', () => {
      calls.push('6301');
      return Promise.resolve();
    }, {
      reply: async () => { throw new Error('send exploded'); },
    });
    assert.equal((await ctx.bridge.handleMessage(message)).accepted, true);
    ctx.queue.overwrite('outbox', '6301', {
      replyTo: '6301',
      channelId: '222',
      text: 'answer',
      final: true,
    });
    ctx.bridge.resolveMessage = async () => message;
    const results = await ctx.bridge.flushOutbox();
    assert.equal(results[0].dead, true);
    assert.equal(ctx.queue.read('dead', '6301').error, 'send_failed');
    assert.equal(ctx.bridge.typing.size, 0);
    const frozen = calls.length;
    advance(30000);
    assert.equal(calls.length, frozen);
  });

  it('stops typing at the 5 minute cap', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = typingMessage('6401', () => {
      calls.push('6401');
      return Promise.resolve();
    });
    assert.equal((await ctx.bridge.handleMessage(message)).accepted, true);
    assert.equal(calls.length, 1);
    advance(7999);
    assert.equal(calls.length, 1);
    advance(1);
    assert.equal(calls.length, 2);

    advance(TYPING_CAP_DEFAULT - 8000);
    assert.equal(ctx.bridge.typing.size, 0);
    assert.equal(calls.length, 38);
    advance(16000);
    assert.equal(calls.length, 38);
  });

  it('never starts typing for rejected or ignored messages', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const sendTyping = () => {
      calls.push('nope');
      return Promise.resolve();
    };
    const ignored = [
      typingMessage('6501', sendTyping, { mention: false, content: 'just chatting' }),
      typingMessage('6502', sendTyping, { userId: '999' }),
      typingMessage('6503', sendTyping, { content: '!!rulereader' }),
      typingMessage('6504', sendTyping, { bot: true, userId: '777', content: '<@444> hi' }),
    ];
    const reasons = [];
    for (const message of ignored) {
      reasons.push((await ctx.bridge.handleMessage(message)).reason);
    }
    assert.deepEqual(reasons, ['not_mention', 'user_denied', 'prefix_command', 'ignore_bot']);
    assert.equal(calls.length, 0);
    assert.equal(ctx.bridge.typing.size, 0);
    assert.deepEqual(ctx.queue.list('inbox'), []);
    advance(60000);
    assert.equal(calls.length, 0);
  });

  it('swallows a sendTyping rejection and keeps the queue moving', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    let calls = 0;
    const rejected = typingMessage('6601', () => {
      calls += 1;
      return Promise.reject(new Error('missing access'));
    });
    const accepted = await ctx.bridge.handleMessage(rejected);
    await Promise.resolve();
    assert.equal(accepted.accepted, true);
    assert.equal(ctx.queue.read('inbox', '6601').text, 'hello');
    assert.equal(calls, 1);
    let logged = ctx.log.entries.filter((entry) => entry.event === 'typing_failed');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].level, 'warn');
    assert.equal(logged[0].messageId, '6601');

    advance(8000);
    await Promise.resolve();
    assert.equal(calls, 2);
    logged = ctx.log.entries.filter((entry) => entry.event === 'typing_failed');
    assert.equal(logged.length, 2);
    assert.equal(ctx.bridge.typing.size, 1);
    assert.equal(ctx.wakes.length, 1);

    const thrown = typingMessage('6602', () => {
      throw new Error('typing unavailable');
    });
    const second = await ctx.bridge.handleMessage(thrown);
    assert.equal(second.accepted, true);
    assert.ok(ctx.queue.read('inbox', '6602'));
    assert.ok(ctx.log.entries.some((entry) => entry.event === 'typing_failed' && entry.messageId === '6602'));
  });

  it('STOP clears the timers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = typingMessage('6701', () => {
      calls.push('6701');
      return Promise.resolve();
    });
    assert.equal((await ctx.bridge.handleMessage(message)).accepted, true);
    assert.equal(ctx.bridge.typing.size, 1);
    ctx.bridge.stop();
    assert.equal(ctx.bridge.typing.size, 0);
    advance(60000);
    assert.deepEqual(calls, ['6701']);
  });

  it('the STOP file clears typing timers without another refresh', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const first = typingMessage('6801', () => {
      calls.push('6801');
      return Promise.resolve();
    });
    const second = typingMessage('6802', () => {
      calls.push('6802');
      return Promise.resolve();
    });
    assert.equal((await ctx.bridge.handleMessage(first)).accepted, true);
    assert.equal((await ctx.bridge.handleMessage(second)).accepted, true);

    fs.writeFileSync(ctx.stop, 'stop\n');
    advance(8000);
    assert.deepEqual(calls, ['6801', '6802']);
    assert.equal(ctx.bridge.typing.size, 0);

    const third = typingMessage('6803', () => {
      calls.push('6803');
      return Promise.resolve();
    });
    assert.equal((await ctx.bridge.handleMessage(third)).reason, 'kill_switch');
    assert.equal(calls.includes('6803'), false);

    const restarted = setup();
    dirs.push(restarted.root);
    const again = typingMessage('6804', () => {
      calls.push('6804');
      return Promise.resolve();
    });
    assert.equal((await restarted.bridge.handleMessage(again)).accepted, true);
    fs.writeFileSync(restarted.stop, 'stop\n');
    restarted.bridge.noteKillSwitch();
    assert.equal(restarted.bridge.typing.size, 0);
    advance(30000);
    assert.equal(calls.includes('6804'), true);
    assert.equal(calls.filter((id) => id === '6804').length, 1);
  });

  it('clamps the typing interval and cap and keeps the bridge disabled by default', () => {
    assert.equal(TYPING_INTERVAL_DEFAULT, 8000);
    assert.equal(TYPING_CAP_DEFAULT, 300000);
    assert.equal(TYPING_INTERVAL_MIN, 1000);
    assert.equal(TYPING_INTERVAL_MAX, 20000);
    assert.equal(TYPING_CAP_MIN, 10000);
    assert.equal(TYPING_CAP_MAX, 900000);

    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
    assert.equal(example.features.enabled, false);
    assert.equal(example.policy.typingIntervalMs, 8000);
    assert.equal(example.policy.typingCapMs, 300000);
    assert.equal(defaultConfig().features.enabled, false);
    assert.equal(defaultConfig().policy.typingIntervalMs, 8000);
    assert.equal(defaultConfig().policy.typingCapMs, 300000);

    const clamped = defaultConfig();
    clamped.policy.typingIntervalMs = 10;
    clamped.policy.typingCapMs = 9e9;
    clampConfig(clamped);
    assert.equal(clamped.policy.typingIntervalMs, TYPING_INTERVAL_MIN);
    assert.equal(clamped.policy.typingCapMs, TYPING_CAP_MAX);
    assert.equal(clamped.features.enabled, false);

    const lowCap = defaultConfig();
    lowCap.policy.typingCapMs = 5;
    clampConfig(lowCap);
    assert.equal(lowCap.policy.typingCapMs, TYPING_CAP_MIN);
  });

  it('applies the typing clamps when the bridge is constructed without clampConfig', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = setup({ policy: { typingIntervalMs: 10, typingCapMs: 50 } });
    dirs.push(ctx.root);
    const calls = [];
    const message = typingMessage('6901', () => {
      calls.push('6901');
      return Promise.resolve();
    });
    assert.equal((await ctx.bridge.handleMessage(message)).accepted, true);
    assert.equal(calls.length, 1);
    advance(999);
    assert.equal(calls.length, 1);
    advance(1);
    assert.equal(calls.length, 2);
    advance(9000, 1000);
    assert.equal(ctx.bridge.typing.size, 0);
    const frozen = calls.length;
    advance(5000);
    assert.equal(calls.length, frozen);
    assert.equal(calls.length, 10);
  });
});
