'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  Bridge,
  FileQueue,
  attachToClient,
  allowedMentions,
  signRecord,
} = require('../discord-bridge');
const { contentFor } = require('../discord-bridge/post-reply');
const {
  parseEnvelopeJson,
  decodeBase64Url,
  NonceStore,
  selectKeys,
  verifyEnvelope,
  NONCE_TTL_MS,
  ROTATION_WINDOW_MS,
} = require('../discord-bridge/src/envelope');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

const KEY = 'test-envelope-key-1';
const PREVIOUS = 'test-envelope-key-0';
const QUEUE_KEY = 'test-hmac-key-value';
const BOT = '444';
const OUTBOX = '900';
const WEBHOOK = '555';

function clocked(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    set(value) { now = value; },
    advance(ms) { now += ms; },
  };
}

function setup(extra = {}) {
  const root = tempDir('phicc-envelope-');
  const time = extra.time || clocked();
  const alerts = [];
  const config = enabledConfig({
    queue: { dir: path.join(root, 'queue'), requireOutboxSig: true },
    features: { enabled: true, killSwitchFile: path.join(root, 'STOP') },
    envelope: {
      enabled: true,
      outboxChannelId: OUTBOX,
      webhookIds: [WEBHOOK],
      rotationWindowMs: ROTATION_WINDOW_MS,
    },
    policy: {
      rateLimits: { perUserPerMin: 10, perChannelPerMin: 30, globalPerHour: 30, globalPerDay: 100 },
    },
  });
  const queue = new FileQueue(config.queue.dir);
  const bridge = new Bridge({
    client: { user: { id: BOT } },
    config,
    queue,
    log: memoryLogger(),
    wake: { notify: async () => {}, stop() {}, discardPending() {} },
    hmacKey: QUEUE_KEY,
    now: time.now,
    sleep: async () => {},
    resolveMessage: extra.resolveMessage,
    alerter: { send: async (entry) => { alerts.push(entry); return entry; } },
  });
  bridge.enableEnvelope({
    currentKey: extra.currentKey === undefined ? KEY : extra.currentKey,
    previousKey: extra.previousKey || '',
    previousSince: extra.previousSince,
    botId: BOT,
  });
  return { root, time, alerts, config, queue, bridge };
}

function record(overrides = {}) {
  return {
    v: 1,
    rid: overrides.rid || '100000000000000701',
    ch: overrides.ch || '222',
    part: overrides.part || 1,
    parts: overrides.parts || 1,
    nonce: overrides.nonce || 'ab'.repeat(16),
    ts: overrides.ts == null ? 1_700_000_000_000 : overrides.ts,
    body: overrides.body == null ? 'hello from the envelope' : overrides.body,
  };
}

function envelopeMessage(rec, overrides = {}) {
  const key = overrides.key || KEY;
  const deleted = overrides.deleted || [];
  const id = overrides.id || '100000000000000801';
  const content = overrides.content == null ? contentFor(rec, key, BOT) : overrides.content;
  const message = fakeMessage({
    id,
    content,
    channelId: overrides.channelId === undefined ? OUTBOX : overrides.channelId,
    webhookId: overrides.webhookId === undefined ? WEBHOOK : overrides.webhookId,
    bot: true,
    userId: WEBHOOK,
    mention: true,
  });
  message.delete = async () => { deleted.push(id); };
  return message;
}

async function pending(ctx, id = '100000000000000701') {
  const replies = [];
  const mentionDeletes = [];
  const message = fakeMessage({
    id,
    content: '<@444> hello',
    reply: async (payload) => {
      replies.push(payload);
      return { id: `reply-${id}` };
    },
    reactions: { cache: { get: () => null } },
  });
  message.delete = async () => { mentionDeletes.push(id); };
  ctx.bridge.resolveMessage = async () => message;
  const accepted = await ctx.bridge.handleMessage(message);
  assert.equal(accepted.accepted, true);
  return { message, replies, mentionDeletes };
}

describe('signed envelope listener', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('stays off unless configured and the user path still drops webhooks', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const off = new Bridge({
      client: { user: { id: BOT } },
      config: enabledConfig({
        queue: { dir: path.join(ctx.root, 'other') },
        features: { enabled: true, killSwitchFile: path.join(ctx.root, 'STOP2') },
      }),
      queue: new FileQueue(path.join(ctx.root, 'other')),
      log: memoryLogger(),
      wake: { notify: async () => {}, stop() {} },
      now: ctx.time.now,
    });
    const ignored = await off.handleEnvelope(fakeMessage({ webhookId: WEBHOOK }));
    assert.equal(ignored.reason, 'envelope_off');

    const root = tempDir('phicc-envelope-off-');
    dirs.push(root);
    const client = new EventEmitter();
    const attached = attachToClient(client, {
      config: enabledConfig({
        features: { enabled: false, killSwitchFile: path.join(root, 'STOP') },
        queue: { dir: path.join(root, 'queue') },
        envelope: { enabled: false },
      }),
      env: { DBR_TOKEN_LOCK_DIR: path.join(root, 'locks') },
      log: memoryLogger(),
      lock: false,
      autostart: false,
    });
    assert.equal(attached.envelope, null);
    assert.equal(attached.envelopeListener, undefined);
    attached.stop();

    const turnedOn = attachToClient(new EventEmitter(), {
      config: enabledConfig({
        features: { enabled: false, killSwitchFile: path.join(root, 'STOP3') },
        queue: { dir: path.join(root, 'queue2') },
        envelope: { enabled: true, outboxChannelId: OUTBOX, webhookIds: [WEBHOOK] },
      }),
      env: {
        DBR_TOKEN_LOCK_DIR: path.join(root, 'locks'),
        ENVELOPE_HMAC_KEY: KEY,
      },
      log: memoryLogger(),
      lock: false,
      autostart: false,
    });
    assert.ok(turnedOn.envelope);
    turnedOn.stop();

    const { message } = await pending(ctx);
    const webhook = fakeMessage({
      id: '100000000000000799',
      content: '<@444> DBR1 not-an-envelope',
      webhookId: WEBHOOK,
      channelId: '222',
      bot: true,
    });
    const dropped = await ctx.bridge.handleMessage(webhook);
    assert.equal(dropped.reason, 'ignore_webhook');
    assert.equal(ctx.queue.exists('inbox', webhook.id), false);
    assert.equal(ctx.queue.exists('inbox', message.id), true);
  });

  it('rejects each check in order, then replies once and deletes the envelope', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const { mentionDeletes } = await pending(ctx);
    let replies = [];
    const deleted = [];

    const badChannel = envelopeMessage(record(), {
      id: '100000000000000811',
      channelId: '222',
      deleted,
    });
    const channelResult = await ctx.bridge.handleEnvelope(badChannel);
    assert.equal(channelResult.reason, 'not_envelope');
    assert.equal(ctx.queue.exists('inbox', '100000000000000701'), true);
    assert.equal(ctx.queue.exists('dead', badChannel.id), false);

    const badWebhook = envelopeMessage(record(), {
      id: '100000000000000812',
      webhookId: '999',
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(badWebhook)).reason, 'bad_webhook');
    assert.equal(ctx.queue.exists('inbox', '100000000000000701'), true);

    const userTyped = envelopeMessage(record(), {
      id: '100000000000000813',
      webhookId: null,
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(userTyped)).reason, 'bad_webhook');

    const oversized = envelopeMessage(record(), {
      id: '100000000000000814',
      content: `<@${BOT}> DBR1 ${'a'.repeat(2000)}`,
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(oversized)).reason, 'size');

    const badDecode = envelopeMessage(record(), {
      id: '100000000000000815',
      content: `<@${BOT}> DBR1 ${Buffer.from('{"no":true}', 'utf8').toString('base64url')}`,
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(badDecode)).reason, 'decode');
    assert.equal(parseEnvelopeJson(Buffer.alloc(9000)).reason, 'size');
    assert.equal(decodeBase64Url('abc+def'), null);

    const forged = record({ nonce: 'cd'.repeat(16) });
    const signed = signRecord(forged, KEY);
    signed.sig = '0'.repeat(64);
    const badMac = envelopeMessage(forged, {
      id: '100000000000000816',
      content: `<@${BOT}> DBR1 ${Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url')}`,
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(badMac)).reason, 'hmac');
    assert.equal(ctx.queue.exists('inbox', '100000000000000701'), true);

    const stale = envelopeMessage(record({
      nonce: 'ef'.repeat(16),
      ts: ctx.time.now() - (31 * 60 * 1000),
    }), { id: '100000000000000817', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(stale)).reason, 'stale');
    assert.equal(ctx.queue.exists('dead', '100000000000000701'), true);
    assert.equal(ctx.queue.exists('inbox', '100000000000000701'), false);

    const postedMention = await pending(ctx, '100000000000000702');
    replies = postedMention.replies;
    const first = record({
      rid: '100000000000000702',
      nonce: '11'.repeat(16),
      body: 'first copy',
    });
    const replayMessage = envelopeMessage(first, { id: '100000000000000818', deleted });
    const posted = await ctx.bridge.handleEnvelope(replayMessage);
    assert.equal(posted.done, true);
    const again = envelopeMessage(first, { id: '100000000000000819', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(again)).reason, 'already_done');
    assert.equal(ctx.queue.exists('dead', '100000000000000702'), false);
    assert.equal(replies.length, 1);

    await pending(ctx, '100000000000000703');
    const missing = envelopeMessage(record({
      rid: '100000000000000799',
      nonce: '22'.repeat(16),
    }), { id: '100000000000000820', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(missing)).reason, 'not_pending');
    assert.equal(ctx.queue.exists('inbox', '100000000000000703'), true);

    const mismatch = envelopeMessage(record({
      rid: '100000000000000703',
      ch: '333',
      nonce: '33'.repeat(16),
    }), { id: '100000000000000821', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(mismatch)).reason, 'channel_mismatch');

    ctx.queue.enqueue(signRecord({
      id: '100000000000000704',
      discordMessageId: '100000000000000704',
      channelId: '999',
      guildId: '111',
      text: 'elsewhere',
      authorIdHash: 'abc',
      authorDisplayName: 'Mina',
      trust: 'untrusted_discord_content',
      createdTimestamp: ctx.time.now(),
      enqueuedAt: new Date(ctx.time.now()).toISOString(),
    }, QUEUE_KEY));
    const denied = envelopeMessage(record({
      rid: '100000000000000704',
      ch: '999',
      nonce: '44'.repeat(16),
    }), { id: '100000000000000822', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(denied)).reason, 'channel_denied');

    await pending(ctx, '100000000000000705');
    const early = envelopeMessage(record({
      rid: '100000000000000705',
      part: 1,
      parts: 2,
      nonce: '55'.repeat(16),
      body: 'hello ',
    }), { id: '100000000000000823', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(early)).waiting, true);
    ctx.time.advance((5 * 60 * 1000) + 1);
    const late = envelopeMessage(record({
      rid: '100000000000000705',
      part: 2,
      parts: 2,
      nonce: '66'.repeat(16),
      body: 'late',
    }), { id: '100000000000000824', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(late)).reason, 'parts_timeout');
    assert.ok(deleted.includes(early.id));
    assert.equal(ctx.queue.exists('dead', '100000000000000705'), true);

    const linked = await pending(ctx, '100000000000000706');
    replies = linked.replies;
    mentionDeletes.push(...linked.mentionDeletes);
    const left = envelopeMessage(record({
      rid: '100000000000000706',
      part: 1,
      parts: 2,
      nonce: '77'.repeat(16),
      body: 'see ',
    }), { id: '100000000000000825', deleted });
    const right = envelopeMessage(record({
      rid: '100000000000000706',
      part: 2,
      parts: 2,
      nonce: '88'.repeat(16),
      body: 'https://discord.gg/example-invite please',
    }), { id: '100000000000000826', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(left)).waiting, true);
    const done = await ctx.bridge.handleEnvelope(right);
    assert.equal(done.done, true);
    const payload = replies.at(-1);
    assert.deepEqual(payload.allowedMentions, allowedMentions());
    assert.match(payload.content, /\[link removed\]/);
    assert.equal(payload.content.includes('https://discord.gg'), false);
    assert.equal(ctx.queue.exists('done', '100000000000000706'), true);
    assert.ok(deleted.includes(left.id));
    assert.ok(deleted.includes(right.id));
    assert.equal(mentionDeletes.length, 0);

    const second = envelopeMessage(record({
      rid: '100000000000000706',
      nonce: '99'.repeat(16),
      body: 'again',
    }), { id: '100000000000000827', deleted });
    const before = replies.length;
    assert.equal((await ctx.bridge.handleEnvelope(second)).reason, 'already_done');
    assert.equal(ctx.queue.exists('dead', '100000000000000706'), false);
    assert.equal(replies.length, before);

    assert.equal(ctx.alerts.some((entry) => entry.detail === 'bad_channel'), false);
    assert.equal(JSON.stringify(ctx.alerts).includes(KEY), false);
  });

  it('accepts either key inside the rotation window and only the new key after it', async () => {
    const time = clocked();
    const ctx = setup({
      time,
      previousKey: PREVIOUS,
      previousSince: time.now() - 1000,
    });
    dirs.push(ctx.root);
    await pending(ctx, '100000000000000708');
    const deleted = [];
    const old = envelopeMessage(record({
      rid: '100000000000000708',
      nonce: 'aa'.repeat(16),
      body: 'signed with the previous key',
    }), { id: '100000000000000830', key: PREVIOUS, deleted });
    assert.equal((await ctx.bridge.handleEnvelope(old)).done, true);

    await pending(ctx, '100000000000000709');
    ctx.bridge.envelope.previousSince = time.now() - ROTATION_WINDOW_MS - 1;
    const expired = envelopeMessage(record({
      rid: '100000000000000709',
      nonce: 'bb'.repeat(16),
    }), { id: '100000000000000831', key: PREVIOUS, deleted });
    assert.equal((await ctx.bridge.handleEnvelope(expired)).reason, 'hmac');
    assert.equal(ctx.queue.exists('inbox', '100000000000000709'), true);

    const current = envelopeMessage(record({
      rid: '100000000000000709',
      nonce: 'cc'.repeat(16),
      body: 'signed with the current key',
    }), { id: '100000000000000832', key: KEY, deleted });
    assert.equal((await ctx.bridge.handleEnvelope(current)).done, true);

    const keys = selectKeys({
      current: KEY,
      previous: PREVIOUS,
      previousSince: time.now() - ROTATION_WINDOW_MS,
      now: time.now(),
      windowMs: ROTATION_WINDOW_MS,
    });
    assert.deepEqual(keys, [KEY, PREVIOUS]);
    const sample = signRecord(record({ nonce: 'dd'.repeat(16) }), PREVIOUS);
    assert.equal(verifyEnvelope(sample, keys), true);
    const closed = selectKeys({
      current: KEY,
      previous: PREVIOUS,
      previousSince: time.now() - ROTATION_WINDOW_MS - 1,
      now: time.now(),
      windowMs: ROTATION_WINDOW_MS,
    });
    assert.deepEqual(closed, [KEY]);
  });

  it('forgets a nonce after 48 hours and sweeps a partial assembly', async () => {
    const root = tempDir('phicc-nonce-');
    dirs.push(root);
    const store = new NonceStore(path.join(root, 'nonces'));
    const nonce = 'ee'.repeat(16);
    assert.equal(store.remember(nonce, 1000), true);
    assert.equal(store.remember(nonce, 1000 + 1000), false);
    assert.equal(store.remember(nonce, 1000 + NONCE_TTL_MS + 1), true);

    const time = clocked();
    const ctx = setup({ time });
    dirs.push(ctx.root);
    await pending(ctx, '100000000000000710');
    const deleted = [];
    const part = envelopeMessage(record({
      rid: '100000000000000710',
      part: 1,
      parts: 2,
      nonce: 'ff'.repeat(16),
      body: 'wait',
    }), { id: '100000000000000840', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(part)).waiting, true);
    time.advance((5 * 60 * 1000) + 5);
    const swept = await ctx.bridge.envelope.sweep();
    assert.equal(swept[0].reason, 'parts_timeout');
    assert.equal(ctx.queue.exists('dead', '100000000000000710'), true);
    assert.equal(fs.existsSync(path.join(ctx.bridge.stateDir(), 'parts', '100000000000000710.json')), false);
  });

  it('ignores a redelivered signed part and does not dead-letter the pending id', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const rid = '100000000000000711';
    await pending(ctx, rid);
    const deleted = [];
    const part = envelopeMessage(record({
      rid,
      part: 1,
      parts: 2,
      nonce: '12'.repeat(16),
      body: 'half ',
    }), { id: '100000000000000850', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(part)).waiting, true);
    const again = await ctx.bridge.handleEnvelope(part);
    assert.equal(again.reason, 'duplicate');
    assert.equal(ctx.queue.exists('inbox', rid), true);
    assert.equal(ctx.queue.exists('dead', rid), false);
    assert.equal(ctx.queue.exists('done', rid), false);
    assert.equal(ctx.alerts.some((entry) => entry.detail === 'replay'), false);
    assert.equal(ctx.alerts.some((entry) => entry.reason === 'envelope_rejected'), false);
  });

  it('leaves a normal mention containing DBR1 to the user path', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const mention = fakeMessage({
      id: '100000000000000860',
      content: '<@444> what is DBR1',
      channelId: '222',
      userId: '333',
    });
    assert.equal((await ctx.bridge.handleEnvelope(mention)).reason, 'not_envelope');
    const accepted = await ctx.bridge.handleMessage(mention);
    assert.equal(accepted.accepted, true);
    assert.equal(ctx.queue.exists('inbox', mention.id), true);
    assert.equal(ctx.queue.exists('dead', mention.id), false);

    const outsider = fakeMessage({
      id: '100000000000000861',
      content: '<@444> DBR1 please',
      channelId: '777',
      userId: '999',
    });
    assert.equal((await ctx.bridge.handleEnvelope(outsider)).reason, 'not_envelope');
    assert.equal(ctx.queue.exists('dead', outsider.id), false);
    assert.equal(ctx.alerts.some((entry) => entry.reason === 'envelope_rejected'), false);
  });

  it('does not post an envelope while features are off', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const rid = '100000000000000712';
    const replies = [];
    ctx.bridge.resolveMessage = async () => fakeMessage({
      id: rid,
      reply: async (payload) => {
        replies.push(payload);
        return { id: 'r' };
      },
    });
    ctx.queue.enqueue(signRecord({
      id: rid,
      discordMessageId: rid,
      channelId: '222',
      guildId: '111',
      text: 'hello',
      authorIdHash: 'abc',
      authorDisplayName: 'Mina',
      trust: 'untrusted_discord_content',
      createdTimestamp: ctx.time.now(),
      enqueuedAt: new Date(ctx.time.now()).toISOString(),
    }, QUEUE_KEY));
    ctx.bridge.config.features.enabled = false;
    const deleted = [];
    const message = envelopeMessage(record({
      rid,
      nonce: '13'.repeat(16),
      body: 'should not post',
    }), { id: '100000000000000870', deleted });
    const result = await ctx.bridge.handleEnvelope(message);
    assert.equal(result.reason, 'disabled');
    assert.equal(replies.length, 0);
    assert.equal(ctx.queue.exists('inbox', rid), true);
    assert.equal(ctx.queue.exists('done', rid), false);
    assert.equal(ctx.alerts.length, 0);
  });
});
