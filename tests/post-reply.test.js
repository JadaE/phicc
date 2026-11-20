'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { postReply, main, splitReply } = require('../discord-bridge/post-reply');
const { decodeBase64Url, parseEnvelopeJson, verifyEnvelope } = require('../discord-bridge/src/envelope');
const { tempDir, rmrf } = require('./helpers');

const KEY = 'test-envelope-key-1';
const URL = 'https://discord.com/api/webhooks/100000000000000555/placeholder-token';
const BOT = '100000000000000444';
const MSG = '100000000000000777';
const CHANNEL = '100000000000000222';

function env() {
  return {
    OUTBOX_HMAC_KEY: KEY,
    DISCORD_OUTBOX_WEBHOOK_URL: URL,
    DISCORD_BOT_USER_ID: BOT,
  };
}

function decodeContent(content) {
  const match = content.match(/^<@(\d+)> DBR1 ([A-Za-z0-9_-]+)$/);
  assert.ok(match);
  const parsed = parseEnvelopeJson(decodeBase64Url(match[2]));
  assert.equal(parsed.ok, true);
  assert.equal(verifyEnvelope(parsed.record, [KEY]), true);
  return { botId: match[1], record: parsed.record, content };
}

describe('post-reply helper', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('signs, base64url-encodes, and posts mentions of the bot only', async () => {
    const calls = [];
    const result = await postReply({
      msgId: MSG,
      channelId: CHANNEL,
      text: 'hello from the helper',
      env: env(),
      ts: 1700000000000,
      nonces: () => 'ab'.repeat(16),
      transport: async ({ url, body }) => {
        calls.push({ url, body });
        return { status: 204, headers: {} };
      },
    });
    assert.equal(result.parts, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [], users: [BOT] });
    const decoded = decodeContent(calls[0].body.content);
    assert.equal(decoded.botId, BOT);
    assert.equal(decoded.record.body, 'hello from the helper');
    assert.equal(decoded.record.nonce, 'ab'.repeat(16));
    assert.equal(decoded.record.v, 1);
    assert.equal(decoded.record.rid, MSG);
    assert.equal(decoded.record.ch, CHANNEL);
    assert.equal(decoded.content.length <= 2000, true);
  });

  it('splits into at most 8 parts of at most 2000 characters and reassembles', async () => {
    const text = `line ${'q'.repeat(3000)}`;
    const calls = [];
    await postReply({
      msgId: MSG,
      channelId: CHANNEL,
      text,
      env: env(),
      ts: 1700000000000,
      nonces: (() => {
        let n = 0;
        return () => (`${n += 1}`.padStart(32, '0'));
      })(),
      transport: async ({ body }) => {
        calls.push(body);
        return { status: 200, headers: {} };
      },
    });
    assert.ok(calls.length > 1);
    assert.ok(calls.length <= 8);
    const records = calls.map((body) => decodeContent(body.content).record);
    assert.deepEqual(records.map((record) => record.part), records.map((_, index) => index + 1));
    assert.equal(records.every((record) => record.parts === calls.length), true);
    assert.equal(new Set(records.map((record) => record.nonce)).size, records.length);
    assert.equal(records.map((record) => record.body).join(''), text);
    assert.equal(calls.every((body) => body.content.length <= 2000), true);
    assert.equal(calls.every((body) => body.content.includes(KEY)), false);
    assert.equal(calls.every((body) => body.content.includes(URL)), false);
  });

  it('refuses to post when the text needs more than 8 parts', async () => {
    const calls = [];
    await assert.rejects(
      () => postReply({
        msgId: MSG,
        channelId: CHANNEL,
        text: 'z'.repeat(40000),
        env: env(),
        ts: 1700000000000,
        transport: async () => {
          calls.push(1);
          return { status: 200, headers: {} };
        },
      }),
      (err) => err.code === 'TOO_MANY_PARTS',
    );
    assert.equal(calls.length, 0);
    assert.throws(() => splitReply('', { botId: BOT, key: KEY, rid: MSG, ch: CHANNEL, ts: 1 }), /EMPTY/);
  });

  it('honors 429 Retry-After and never prints the key or URL', async () => {
    const root = tempDir('phicc-post-reply-');
    dirs.push(root);
    const slept = [];
    let attempts = 0;
    const calls = [];
    await postReply({
      msgId: MSG,
      channelId: CHANNEL,
      text: 'retry me',
      env: env(),
      ts: 1700000000000,
      sleep: async (ms) => { slept.push(ms); },
      transport: async ({ body }) => {
        attempts += 1;
        calls.push(body);
        if (attempts === 1) return { status: 429, headers: { 'retry-after': '2' }, retryAfterMs: 0 };
        return { status: 204, headers: {} };
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(slept, [2000]);

    const textFile = path.join(root, 'reply.txt');
    const envFile = path.join(root, 'reply.env');
    fs.writeFileSync(textFile, 'from a file\n');
    fs.writeFileSync(envFile, [
      `OUTBOX_HMAC_KEY=${KEY}`,
      `DISCORD_OUTBOX_WEBHOOK_URL=${URL}`,
      `DISCORD_BOT_USER_ID=${BOT}`,
    ].join('\n'));
    const lines = [];
    const code = await main(['node', 'post-reply', MSG, CHANNEL, textFile], {
      envFile,
      ts: 1700000000000,
      log: (line) => lines.push(String(line)),
      errLog: (line) => lines.push(String(line)),
      transport: async () => ({ status: 204, headers: {} }),
    });
    assert.equal(code, 0);
    const output = lines.join('\n');
    assert.match(output, /"event":"posted"/);
    assert.equal(output.includes(KEY), false);
    assert.equal(output.includes(URL), false);
    assert.equal(output.includes('placeholder-token'), false);

    const failed = [];
    const bad = await main(['node', 'post-reply', MSG, CHANNEL, path.join(root, 'missing.txt')], {
      envFile,
      log: (line) => failed.push(String(line)),
      errLog: (line) => failed.push(String(line)),
      transport: async () => ({ status: 204, headers: {} }),
    });
    assert.equal(bad, 1);
    const errText = failed.join('\n');
    assert.match(errText, /TEXT_FILE/);
    assert.equal(errText.includes(KEY), false);
    assert.equal(errText.includes(URL), false);
  });

  it('rejects a non-discord webhook before any request', async () => {
    const calls = [];
    await assert.rejects(
      () => postReply({
        msgId: MSG,
        channelId: CHANNEL,
        text: 'nope',
        env: { ...env(), DISCORD_OUTBOX_WEBHOOK_URL: 'http://discord.com/api/webhooks/1/abc' },
        transport: async () => { calls.push(1); return { status: 204 }; },
      }),
      (err) => err.code === 'WEBHOOK_HTTPS',
    );
    await assert.rejects(
      () => postReply({
        msgId: MSG,
        channelId: CHANNEL,
        text: 'nope',
        env: { ...env(), DISCORD_OUTBOX_WEBHOOK_URL: 'https://example.test/hook' },
        transport: async () => { calls.push(1); return { status: 204 }; },
      }),
      (err) => err.code === 'WEBHOOK_HOST',
    );
    assert.equal(calls.length, 0);
  });
});
