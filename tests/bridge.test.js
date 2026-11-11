'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Bridge, FileQueue, ALLOWED_MENTIONS, TRUNCATION_NOTE } = require('../discord-bridge');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

function setup(overrides = {}) {
  const root = tempDir('phicc-bridge-');
  const stop = path.join(root, 'STOP');
  const config = enabledConfig({
    queue: { dir: path.join(root, 'queue') },
    features: { enabled: true, killSwitchFile: stop },
    policy: {
      reactions: { ack: '👀', done: '✅', fail: '❌', enabled: true },
      commsTimeoutMinutes: 10,
      maxReplyChars: 1900,
      maxReplyChunks: 3,
      rateLimits: { perUserPerMin: 3, perChannelPerMin: 10, globalPerHour: 60 },
    },
    ...(overrides.config || {}),
  });
  if (overrides.rateLimits) config.policy.rateLimits = overrides.rateLimits;
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
    now: overrides.now || (() => 1_700_000_000_000),
    resolveMessage: overrides.resolveMessage,
  });
  return { root, stop, config, queue, log, wakes, bridge };
}

describe('bridge message path', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('queues a mention once, acks it, and wakes without storing the raw user id', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const reactions = [];
    const message = fakeMessage({
      id: '5001',
      content: '<@444> hello there',
      react: async (emoji) => { reactions.push(emoji); },
    });
    const first = await ctx.bridge.handleMessage(message);
    const second = await ctx.bridge.handleMessage(message);
    assert.equal(first.accepted, true);
    assert.equal(second.reason, 'duplicate');
    assert.deepEqual(ctx.wakes, ['5001']);
    assert.deepEqual(reactions, ['👀']);
    const stored = ctx.queue.read('inbox', '5001');
    assert.equal(stored.text, 'hello there');
    assert.equal(stored.authorDisplayName, 'Jada');
    assert.equal(JSON.stringify(stored).includes('"333"'), false);
    assert.equal(ctx.queue.list('inbox').length, 1);
  });

  it('drops non-mentions, foreign users, and !! commands before the queue', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    assert.equal((await ctx.bridge.handleMessage(fakeMessage({
      id: '5002',
      mention: false,
      content: 'just chatting',
    }))).reason, 'not_mention');
    assert.equal((await ctx.bridge.handleMessage(fakeMessage({
      id: '5003',
      userId: '999',
    }))).reason, 'user_denied');
    assert.equal((await ctx.bridge.handleMessage(fakeMessage({
      id: '5004',
      content: '!!rulereader',
    }))).reason, 'prefix_command');
    assert.deepEqual(ctx.queue.list('inbox'), []);
    assert.equal(ctx.log.entries.some((entry) => entry.reason === 'not_mention'), true);
    assert.equal(ctx.log.entries.some((entry) => entry.reason === 'prefix_command'), false);
  });

  it('stops queueing when the kill switch file exists and trips it on the global cap', async () => {
    const ctx = setup({ rateLimits: { perUserPerMin: 10, perChannelPerMin: 10, globalPerHour: 1 } });
    dirs.push(ctx.root);
    assert.equal((await ctx.bridge.handleMessage(fakeMessage({ id: '5101' }))).accepted, true);
    const tripped = await ctx.bridge.handleMessage(fakeMessage({ id: '5102', userId: '333' }));
    assert.equal(tripped.reason, 'rate_limited_global');
    assert.equal(fs.existsSync(ctx.stop), true);
    const silenced = await ctx.bridge.handleMessage(fakeMessage({ id: '5103' }));
    assert.equal(silenced.reason, 'kill_switch');
    assert.equal(ctx.queue.seen('5102'), false);
    assert.equal(ctx.queue.seen('5103'), false);
  });

  it('replies with empty mention parsing, chunks, and moves inbox to done', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = fakeMessage({
      id: '5201',
      reply: async (payload) => { calls.push(payload); return { id: 'r1' }; },
      reactions: { cache: { get: () => null } },
    });
    await ctx.bridge.handleMessage(message);
    ctx.queue.overwrite('outbox', '5201', {
      replyTo: '5201',
      channelId: '222',
      text: 'y'.repeat(4000),
      final: true,
    });
    ctx.bridge.resolveMessage = async () => message;
    const results = await ctx.bridge.flushOutbox();
    assert.equal(results[0].done, true);
    assert.equal(calls.length, 3);
    for (const payload of calls) {
      assert.deepEqual(payload.allowedMentions, ALLOWED_MENTIONS);
      assert.ok(payload.content.length <= 1900);
    }
    assert.equal(calls.map((payload) => payload.content).join(''), 'y'.repeat(4000));
    assert.equal(ctx.queue.read('inbox', '5201'), null);
    assert.equal(ctx.queue.read('done', '5201').status, 'done');
    const again = await ctx.bridge.flushOutbox();
    assert.deepEqual(again, []);
    assert.equal(calls.length, 3);
  });

  it('dead-letters a send failure and still refuses to ping anyone', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = fakeMessage({
      id: '5301',
      reply: async (payload) => {
        calls.push(payload);
        throw new Error('send exploded');
      },
    });
    await ctx.bridge.handleMessage(message);
    ctx.queue.overwrite('outbox', '5301', {
      replyTo: '5301',
      channelId: '222',
      text: 'answer',
      final: true,
    });
    ctx.bridge.resolveMessage = async () => message;
    const results = await ctx.bridge.flushOutbox();
    assert.equal(results[0].dead, true);
    assert.equal(ctx.queue.read('dead', '5301').error, 'send_failed');
    assert.equal(ctx.queue.read('outbox', '5301'), null);
    assert.ok(calls.length >= 2);
    for (const payload of calls) assert.deepEqual(payload.allowedMentions, ALLOWED_MENTIONS);
    assert.equal(calls.some((payload) => payload.content.includes("Couldn't answer")), true);
  });

  it('posts a long answer with a truncation note and will not answer the wrong channel', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const calls = [];
    const message = fakeMessage({
      id: '5401',
      reply: async (payload) => { calls.push(payload); },
    });
    await ctx.bridge.handleMessage(message);
    ctx.bridge.resolveMessage = async () => message;
    ctx.queue.overwrite('outbox', '5401', {
      replyTo: '5401',
      channelId: '999',
      text: 'nope',
      final: true,
    });
    const mismatch = await ctx.bridge.flushOutbox();
    assert.equal(mismatch[0].reason, 'channel_mismatch');
    assert.equal(calls.length, 0);

    await ctx.bridge.queue.enqueue({
      discordMessageId: '5402',
      channelId: '222',
      guildId: '111',
      text: 'again',
      createdTimestamp: 2,
      enqueuedAt: new Date().toISOString(),
    });
    ctx.queue.overwrite('outbox', '5402', {
      replyTo: '5402',
      channelId: '222',
      text: 'z'.repeat(8000),
      final: true,
    });
    ctx.bridge.resolveMessage = async () => fakeMessage({
      id: '5402',
      reply: async (payload) => { calls.push(payload); },
    });
    const sent = await ctx.bridge.flushOutbox();
    assert.equal(sent[0].done, true);
    assert.equal(calls.length, 3);
    assert.ok(calls[2].content.endsWith(TRUNCATION_NOTE));
  });

  it('sends the timeout notice once while the inbox item is still waiting', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    let clock = 1_700_000_000_000;
    ctx.bridge.now = () => clock;
    const calls = [];
    await ctx.bridge.handleMessage(fakeMessage({
      id: '5501',
      createdTimestamp: clock,
    }));
    ctx.bridge.resolveMessage = async () => fakeMessage({
      id: '5501',
      reply: async (payload) => { calls.push(payload); },
    });
    await ctx.bridge.checkTimeouts();
    assert.equal(calls.length, 0);
    clock += 11 * 60 * 1000;
    await ctx.bridge.checkTimeouts();
    await ctx.bridge.checkTimeouts();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].allowedMentions, ALLOWED_MENTIONS);
    assert.match(calls[0].content, /Still working/);
    assert.equal(ctx.queue.read('inbox', '5501').timeoutNotified, true);
  });

  it('replies in a thread whose parent channel is allowlisted', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    ctx.config.discord.allowThreads = true;
    const calls = [];
    const message = fakeMessage({
      id: '5701',
      thread: true,
      channelId: '3333',
      parentId: '222',
      reply: async (payload) => { calls.push(payload); },
    });
    const accepted = await ctx.bridge.handleMessage(message);
    assert.equal(accepted.accepted, true);
    assert.equal(ctx.queue.read('inbox', '5701').channelId, '3333');
    assert.equal(ctx.queue.read('inbox', '5701').parentChannelId, '222');
    ctx.queue.overwrite('outbox', '5701', {
      replyTo: '5701',
      channelId: '3333',
      text: 'thread reply',
      final: true,
    });
    ctx.bridge.resolveMessage = async () => message;
    const results = await ctx.bridge.flushOutbox();
    assert.equal(results[0].done, true);
    assert.equal(calls[0].content, 'thread reply');
    assert.deepEqual(calls[0].allowedMentions, ALLOWED_MENTIONS);
  });

  it('strips token-like text before queueing and stays quiet while the switch is on', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;
    await ctx.bridge.handleMessage(fakeMessage({
      id: '5601',
      content: `<@444> leak ${token} please`,
    }));
    const stored = ctx.queue.read('inbox', '5601');
    assert.equal(stored.text.includes(token), false);
    assert.match(stored.text, /\[redacted\]/);
    fs.writeFileSync(ctx.stop, 'stop\n');
    const silenced = await ctx.bridge.handleMessage(fakeMessage({ id: '5602' }));
    assert.equal(silenced.reason, 'kill_switch');
    const calls = [];
    ctx.queue.overwrite('outbox', '5601', {
      replyTo: '5601',
      channelId: '222',
      text: 'answer',
      final: true,
    });
    ctx.bridge.resolveMessage = async () => fakeMessage({
      reply: async (payload) => { calls.push(payload); },
    });
    const flushed = await ctx.bridge.flushOutbox();
    assert.equal(flushed.skipped, true);
    assert.equal(calls.length, 0);
  });
});
