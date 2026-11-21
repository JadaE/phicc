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
  assertReady,
  defaultConfig,
} = require('../discord-bridge');
const { stripOutbound } = require('../discord-bridge/src/bridge');
const { contentFor } = require('../discord-bridge/post-reply');
const {
  parseEnvelopeJson,
  decodeBase64Url,
  NonceStore,
  SeenIds,
  selectKeys,
  verifyEnvelope,
  NONCE_TTL_MS,
  SEEN_TTL_MS,
  SEEN_SWEEP_LIMIT,
  ALERT_WINDOW_MS,
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
  const log = extra.log || memoryLogger();
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
    log,
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
  return { root, time, alerts, config, queue, bridge, log };
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
    assert.equal(ctx.queue.exists('dead', '100000000000000701'), false);
    assert.equal(ctx.queue.exists('inbox', '100000000000000701'), true);
    assert.ok(deleted.includes(stale.id));

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
      body: 'https://discord.gg/example-invite https://discord.com/api/webhooks/123/whsec-token-aaa https://discordapp.com/api/webhooks/456/whsec-token-bbb please',
    }), { id: '100000000000000826', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(left)).waiting, true);
    const done = await ctx.bridge.handleEnvelope(right);
    assert.equal(done.done, true);
    const payload = replies.at(-1);
    assert.deepEqual(payload.allowedMentions, allowedMentions());
    assert.match(payload.content, /\[link removed\]/);
    assert.equal(payload.content.includes('https://discord.gg'), false);
    assert.equal(payload.content.includes('api/webhooks'), false);
    assert.equal(payload.content.includes('whsec-token-aaa'), false);
    assert.equal(payload.content.includes('whsec-token-bbb'), false);
    assert.equal(payload.content.includes('discordapp.com'), false);
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

  it('logs unauthenticated rejects without a P0 or a dead file', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const rid = '100000000000000721';
    await pending(ctx, rid);
    const deleted = [];
    const ids = ['100000000000000901', '100000000000000902', '100000000000000903'];
    for (const id of ids) {
      const message = envelopeMessage(record({ rid, nonce: 'a1'.repeat(16) }), {
        id,
        webhookId: '999',
        deleted,
      });
      const result = await ctx.bridge.handleEnvelope(message);
      assert.equal(result.reason, 'bad_webhook');
      assert.equal(ctx.queue.exists('dead', id), false);
      assert.ok(deleted.includes(id));
    }
    const badDecode = envelopeMessage(record({ rid }), {
      id: '100000000000000904',
      content: `<@${BOT}> DBR1 ${Buffer.from('{"no":true}', 'utf8').toString('base64url')}`,
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(badDecode)).reason, 'decode');
    const forged = record({ rid, nonce: 'a2'.repeat(16) });
    const signed = signRecord(forged, KEY);
    signed.sig = '0'.repeat(64);
    const badMac = envelopeMessage(forged, {
      id: '100000000000000905',
      content: `<@${BOT}> DBR1 ${Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url')}`,
      deleted,
    });
    assert.equal((await ctx.bridge.handleEnvelope(badMac)).reason, 'hmac');
    assert.equal(ctx.alerts.length, 0);
    assert.equal(ctx.queue.exists('inbox', rid), true);
    assert.equal(ctx.queue.exists('dead', rid), false);
    assert.equal(ctx.queue.exists('dead', badDecode.id), false);
    assert.equal(ctx.queue.exists('dead', badMac.id), false);
    const warns = () => ctx.log.entries.filter((entry) => entry.event === 'envelope_dropped');
    assert.equal(warns().length, 1);
    assert.equal(warns()[0].level, 'warn');
    assert.equal(JSON.stringify(warns()).includes(KEY), false);
    ctx.time.advance(ALERT_WINDOW_MS + 1);
    const again = envelopeMessage(record({ rid }), {
      id: '100000000000000906',
      webhookId: '999',
      deleted,
    });
    await ctx.bridge.handleEnvelope(again);
    assert.equal(warns().length, 2);
    assert.ok(warns()[1].suppressed >= 4);
    assert.equal(ctx.alerts.length, 0);
  });

  it('drops a replay or stale copy and leaves the pending reply in the inbox', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const rid = '100000000000000722';
    await pending(ctx, rid);
    const deleted = [];
    const part = envelopeMessage(record({
      rid,
      part: 1,
      parts: 2,
      nonce: 'b1'.repeat(16),
      body: 'keep ',
    }), { id: '100000000000000910', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(part)).waiting, true);
    const copy = envelopeMessage(record({
      rid,
      part: 1,
      parts: 2,
      nonce: 'b1'.repeat(16),
      body: 'keep ',
    }), { id: '100000000000000911', deleted });
    const replayed = await ctx.bridge.handleEnvelope(copy);
    assert.equal(replayed.dropped, true);
    assert.equal(replayed.reason, 'replay');
    assert.ok(deleted.includes(copy.id));
    assert.equal(deleted.includes(part.id), false);
    assert.equal(ctx.queue.exists('inbox', rid), true);
    assert.equal(ctx.queue.exists('dead', rid), false);
    assert.equal(ctx.queue.exists('done', rid), false);
    assert.equal(ctx.alerts.length, 0);
    assert.equal(fs.existsSync(path.join(ctx.bridge.stateDir(), 'parts', `${rid}.json`)), true);

    const stale = envelopeMessage(record({
      rid,
      part: 2,
      parts: 2,
      nonce: 'b2'.repeat(16),
      ts: ctx.time.now() - (31 * 60 * 1000),
      body: 'late',
    }), { id: '100000000000000912', deleted });
    const dropped = await ctx.bridge.handleEnvelope(stale);
    assert.equal(dropped.dropped, true);
    assert.equal(dropped.reason, 'stale');
    assert.ok(deleted.includes(stale.id));
    assert.equal(deleted.includes(part.id), false);
    assert.equal(ctx.queue.exists('inbox', rid), true);
    assert.equal(ctx.queue.exists('dead', rid), false);
    assert.equal(ctx.alerts.length, 0);

    const replies = [];
    ctx.bridge.resolveMessage = async () => fakeMessage({
      id: rid,
      reply: async (payload) => {
        replies.push(payload);
        return { id: 'kept' };
      },
    });
    const finish = envelopeMessage(record({
      rid,
      part: 2,
      parts: 2,
      nonce: 'b3'.repeat(16),
      body: 'this half',
    }), { id: '100000000000000913', deleted });
    const done = await ctx.bridge.handleEnvelope(finish);
    assert.equal(done.done, true);
    assert.equal(replies.length, 1);
    assert.equal(ctx.queue.exists('done', rid), true);
    assert.equal(ctx.queue.exists('dead', rid), false);
  });

  it('turns a store error into a logged rejection instead of an unhandled rejection', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    const rid = '100000000000000723';
    await pending(ctx, rid);
    ctx.bridge.envelope.seen.add = () => {
      const error = new Error('disk');
      error.code = 'EIO';
      throw error;
    };
    const deleted = [];
    const message = envelopeMessage(record({
      rid,
      nonce: 'c1'.repeat(16),
      body: 'stored',
    }), { id: '100000000000000920', deleted });
    const result = await ctx.bridge.handleEnvelope(message);
    assert.equal(result.rejected, true);
    assert.equal(result.reason, 'store');
    assert.equal(ctx.queue.exists('dead', rid), true);
    const logged = ctx.log.entries.find((entry) => entry.event === 'envelope_store');
    assert.equal(logged.level, 'error');
    assert.equal(logged.code, 'EIO');
    assert.equal(JSON.stringify(logged).includes(KEY), false);

    const ctx2 = setup();
    dirs.push(ctx2.root);
    const pendingId = '100000000000000724';
    await pending(ctx2, pendingId);
    ctx2.bridge.envelope.seen.has = () => {
      const error = new Error('disk');
      error.code = 'EIO';
      throw error;
    };
    const early = envelopeMessage(record({
      rid: pendingId,
      nonce: 'c2'.repeat(16),
    }), { id: '100000000000000921', deleted });
    const unauth = await ctx2.bridge.handleEnvelope(early);
    assert.equal(unauth.reason, 'store');
    assert.equal(ctx2.alerts.length, 0);
    assert.equal(ctx2.queue.exists('dead', early.id), false);
    assert.equal(ctx2.queue.exists('dead', pendingId), false);
    assert.equal(ctx2.queue.exists('inbox', pendingId), true);
  });

  it('coalesces authenticated envelope_rejected alerts inside the window', async () => {
    const ctx = setup();
    dirs.push(ctx.root);
    await pending(ctx, '100000000000000725');
    const deleted = [];
    const first = envelopeMessage(record({
      rid: '100000000000000799',
      nonce: 'd1'.repeat(16),
    }), { id: '100000000000000930', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(first)).reason, 'not_pending');
    assert.equal(ctx.alerts.length, 1);
    assert.equal(ctx.alerts[0].count, 1);
    const second = envelopeMessage(record({
      rid: '100000000000000798',
      nonce: 'd2'.repeat(16),
    }), { id: '100000000000000931', deleted });
    assert.equal((await ctx.bridge.handleEnvelope(second)).reason, 'not_pending');
    assert.equal(ctx.alerts.length, 1);
    ctx.time.advance(ALERT_WINDOW_MS + 1);
    const third = envelopeMessage(record({
      rid: '100000000000000797',
      nonce: 'd3'.repeat(16),
    }), { id: '100000000000000932', deleted });
    await ctx.bridge.handleEnvelope(third);
    assert.equal(ctx.alerts.length, 2);
    assert.ok(ctx.alerts[1].count >= 2);
  });

  it('sweeps seen message ids after 48 hours, bounded and periodic', () => {
    const root = tempDir('phicc-seen-');
    dirs.push(root);
    const dir = path.join(root, 'envelope-seen');
    const seen = new SeenIds(dir);
    const start = 1_700_000_000_000;
    const expired = [];
    for (let n = 0; n < SEEN_SWEEP_LIMIT + 10; n += 1) {
      const id = `9${String(n).padStart(17, '0')}`;
      expired.push(id);
      seen.add(id, start - SEEN_TTL_MS - 5);
    }
    const removed = seen.sweep(start, SEEN_SWEEP_LIMIT);
    assert.equal(removed, SEEN_SWEEP_LIMIT);
    const still = expired.filter((id) => fs.existsSync(path.join(dir, id)));
    assert.equal(still.length, 10);
    assert.equal(seen.sweep(start, SEEN_SWEEP_LIMIT), 10);
    assert.equal(expired.some((id) => fs.existsSync(path.join(dir, id))), false);
    const kept = '100000000000000940';
    seen.add(kept, start);
    assert.equal(seen.has(kept, start), true);
    assert.equal(seen.has(kept, start + SEEN_TTL_MS + 1), false);

    const legacy = '100000000000000941';
    fs.writeFileSync(path.join(dir, legacy), '1\n', { mode: 0o600 });
    assert.equal(seen.sweep(start), 0);
    assert.equal(Number(fs.readFileSync(path.join(dir, legacy), 'utf8')), start);
    assert.equal(seen.sweep(start + SEEN_TTL_MS + 1) >= 1, true);
    assert.equal(fs.existsSync(path.join(dir, legacy)), false);

    const time = clocked(start);
    const ctx = setup({ time });
    dirs.push(ctx.root);
    const oldId = '100000000000000942';
    ctx.bridge.envelope.seen.add(oldId, time.now() - SEEN_TTL_MS - 10);
    assert.equal(ctx.bridge.envelope.sweepSeen(), 1);
    assert.equal(fs.existsSync(path.join(ctx.bridge.stateDir(), 'envelope-seen', oldId)), false);
    const later = '100000000000000943';
    ctx.bridge.envelope.seen.add(later, time.now() - SEEN_TTL_MS - 10);
    assert.equal(ctx.bridge.envelope.sweepSeen(), 0);
    assert.equal(fs.existsSync(path.join(ctx.bridge.stateDir(), 'envelope-seen', later)), true);
    time.advance(60 * 1000);
    assert.equal(ctx.bridge.envelope.sweepSeen(), 1);
    assert.equal(fs.existsSync(path.join(ctx.bridge.stateDir(), 'envelope-seen', later)), false);
    assert.equal(stripOutbound('https://discordapp.com/api/webhooks/1/abc').includes('api/webhooks'), false);
  });

  it('requires botUserId when the envelope is enabled and loads the previous key file', () => {
    const root = tempDir('phicc-bot-user-');
    dirs.push(root);
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
    config.envelope.enabled = true;
    config.envelope.outboxChannelId = '100000000000000900';
    config.envelope.webhookIds = ['100000000000000555'];
    const env = {
      COMMS_WEBHOOK_URL: 'https://hooks.example/wake',
      COMMS_WEBHOOK_KEY: 'test-webhook-key',
      QUEUE_HMAC_KEY: QUEUE_KEY,
      ENVELOPE_HMAC_KEY: KEY,
    };
    assert.throws(() => assertReady(config, { env }), (err) => err.code === 'BOT_USER_REQUIRED');
    config.discord.botUserId = '100000000000000444';
    assert.doesNotThrow(() => assertReady(config, { env }));

    const prevFile = path.join(root, 'envelope_hmac_previous');
    fs.writeFileSync(prevFile, `${PREVIOUS}\n`, { mode: 0o600 });
    const now = 1_700_000_000_000;
    const attached = attachToClient(new EventEmitter(), {
      config: enabledConfig({
        features: { enabled: false, killSwitchFile: path.join(root, 'STOP2') },
        queue: { dir: path.join(root, 'queue') },
        envelope: { enabled: true, outboxChannelId: OUTBOX, webhookIds: [WEBHOOK] },
      }),
      env: {
        DBR_TOKEN_LOCK_DIR: path.join(root, 'locks'),
        ENVELOPE_HMAC_KEY: KEY,
        ENVELOPE_HMAC_KEY_PREVIOUS_FILE: prevFile,
        ENVELOPE_ROTATION_SINCE: String(now - 1000),
      },
      now: () => now,
      log: memoryLogger(),
      lock: false,
      autostart: false,
    });
    assert.equal(attached.envelope.previousKey, PREVIOUS);
    assert.deepEqual(attached.envelope.keys(), [KEY, PREVIOUS]);
    attached.envelope.previousSince = now - ROTATION_WINDOW_MS - 1;
    assert.deepEqual(attached.envelope.keys(), [KEY]);
    assert.equal(JSON.stringify(attached.envelope.keys()).includes('file'), false);
    attached.stop();
  });
});
