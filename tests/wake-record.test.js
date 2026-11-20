'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { WakeHandoff, sanitizeWakeItem, Bridge, FileQueue } = require('../discord-bridge');
const { tempDir, rmrf, enabledConfig, fakeMessage, memoryLogger } = require('./helpers');

describe('wake record body', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('drops raw ids and tokens and caps mention-stripped text', () => {
    const item = sanitizeWakeItem({
      msgId: '100000000000000501',
      channelId: '100000000000000222',
      text: `<@444> ${'z'.repeat(5000)}`,
      authorName: 'Mina',
      authorHash: 'abc',
      authorId: '100000000000000333',
      token: 'super-secret-token-value',
      ts: 1700000000000,
    }, '100000000000000501');
    assert.equal(item.text.length, 4000);
    assert.equal(item.text.includes('<@'), false);
    assert.equal(item.trust, 'untrusted_discord_content');
    assert.equal(Object.hasOwn(item, 'authorId'), false);
    assert.equal(Object.hasOwn(item, 'token'), false);
    assert.equal(JSON.stringify(item).includes('100000000000000333'), false);
    assert.equal(JSON.stringify(item).includes('super-secret-token-value'), false);
  });

  it('sends at most five capped records and keeps the id-only body by default', async () => {
    const calls = [];
    const wake = new WakeHandoff({
      url: 'https://hooks.example/wake',
      key: 'test-webhook-key',
      quietMs: 60000,
      maxBatch: 5,
      maxPerHour: 10,
      carryRecord: true,
      recordFor: (id) => ({
        msgId: id,
        channelId: '222',
        text: id === '1' ? `<@444> ${'m'.repeat(4500)}` : 'hello',
        authorName: 'Mina',
        authorHash: 'hash',
        authorId: '333',
        token: 'super-secret-token-value',
        ts: 1700000000000,
      }),
      fetchImpl: async ({ body }) => {
        calls.push(body);
        return { status: 200, bodyText: '', retryAfterMs: 0 };
      },
    });
    for (let n = 1; n <= 5; n += 1) await wake.notify(String(n));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].v, 1);
    assert.equal(calls[0].items.length, 5);
    assert.equal(calls[0].msgId, undefined);
    assert.equal(calls[0].items[0].text.length, 4000);
    assert.equal(JSON.stringify(calls[0]).includes('super-secret-token-value'), false);
    assert.equal(JSON.stringify(calls[0]).includes('"333"'), false);
    assert.equal(calls[0].items[0].trust, 'untrusted_discord_content');

    const plain = [];
    const legacy = new WakeHandoff({
      url: 'https://hooks.example/wake',
      key: 'test-webhook-key',
      quietMs: 1,
      maxBatch: 5,
      schedule: (fn) => {
        plain.timer = fn;
        return { unref() {} };
      },
      fetchImpl: async ({ body }) => {
        plain.push(body);
        return { status: 200, bodyText: '', retryAfterMs: 0 };
      },
    });
    await legacy.notify('21');
    await plain.timer();
    assert.deepEqual(plain[0], { msgId: '21' });
  });

  it('wakes from the inbox record without a raw user id', async () => {
    const root = tempDir('phicc-wake-record-');
    dirs.push(root);
    const calls = [];
    const config = enabledConfig({
      queue: { dir: `${root}/queue` },
      features: { enabled: true, killSwitchFile: `${root}/STOP` },
      wake: { carryRecord: true },
    });
    const queue = new FileQueue(config.queue.dir);
    const wake = new WakeHandoff({
      url: 'https://hooks.example/wake',
      key: 'test-webhook-key',
      quietMs: 60000,
      maxBatch: 1,
      maxPerHour: 10,
      fetchImpl: async ({ body }) => {
        calls.push(body);
        return { status: 200, bodyText: '', retryAfterMs: 0 };
      },
    });
    const bridge = new Bridge({
      client: { user: { id: '444' } },
      config,
      queue,
      log: memoryLogger(),
      wake,
      hmacKey: 'test-hmac-key-value',
      secrets: ['super-secret-token-value'],
      now: () => 1700000000000,
      sleep: async () => {},
    });
    await bridge.handleMessage(fakeMessage({
      id: '100000000000000501',
      content: '<@444> hello super-secret-token-value there',
      userId: '333',
    }));
    assert.equal(calls.length, 1);
    const item = calls[0].items[0];
    assert.equal(item.msgId, '100000000000000501');
    assert.equal(item.channelId, '222');
    assert.equal(item.text.includes('<@444>'), false);
    assert.equal(item.text.includes('super-secret-token-value'), false);
    assert.equal(item.trust, 'untrusted_discord_content');
    assert.equal(JSON.stringify(calls[0]).includes('"333"'), false);
    bridge.stop();
  });
});
