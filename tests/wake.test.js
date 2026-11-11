'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');
const { WakeHandoff, postWebhook } = require('../discord-bridge');

function harness(options = {}) {
  const calls = [];
  const logs = [];
  const timers = [];
  let now = 1_000_000;
  const wake = new WakeHandoff({
    url: 'https://example.test/hook',
    key: 'test-webhook-key',
    quietMs: 1500,
    maxBatch: 5,
    maxPerHour: 200,
    now: () => now,
    log: (entry) => logs.push(entry),
    schedule: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clear: (timer) => {
      if (timer) timer.cleared = true;
    },
    fetchImpl: async ({ url, key, body }) => {
      calls.push({ url, key, body });
      return { status: 200, bodyText: 'ok', retryAfterMs: 0 };
    },
    ...options,
  });
  return {
    wake,
    calls,
    logs,
    timers,
    setNow(value) { now = value; },
  };
}

describe('comms bot wake handoff', () => {
  it('coalesces a short burst into one POST and treats 200 as started', async () => {
    const { wake, calls, logs, timers } = harness();
    await wake.notify('11');
    await wake.notify('12');
    await wake.notify('13');
    assert.equal(calls.length, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1500);
    await timers[0].fn();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { msgIds: ['11', '12', '13'] });
    assert.equal(JSON.stringify(calls[0].body).includes('hello'), false);
    assert.equal(calls[0].key, 'test-webhook-key');
    assert.equal(logs.some((entry) => entry.event === 'wake_started' && entry.status === 200), true);
    assert.equal(JSON.stringify(logs).includes('test-webhook-key'), false);
  });

  it('sends a single id as msgId and flushes immediately at the batch cap', async () => {
    const { wake, calls, timers } = harness();
    await wake.notify('21');
    await timers[0].fn();
    assert.deepEqual(calls[0].body, { msgId: '21' });

    const capped = harness({ maxBatch: 5 });
    for (let i = 0; i < 4; i += 1) await capped.wake.notify(String(300 + i));
    assert.equal(capped.calls.length, 0);
    await capped.wake.notify('304');
    assert.equal(capped.calls.length, 1);
    assert.deepEqual(capped.calls[0].body.msgIds, ['300', '301', '302', '303', '304']);
  });

  it('backs off on a non-200 and does not tight-loop a routine rate limit', async () => {
    let status = 500;
    const transient = harness({
      fetchImpl: async ({ body }) => {
        transient.calls.push({ body });
        return { status, bodyText: 'unavailable', retryAfterMs: 0 };
      },
    });
    await transient.wake.notify('41');
    await transient.timers[0].fn();
    assert.equal(transient.calls.length, 1);
    assert.equal(transient.logs.some((entry) => entry.event === 'wake_backoff'), true);
    status = 200;
    transient.setNow(1_000_000 + transient.timers.at(-1).ms);
    await transient.timers.at(-1).fn();
    assert.equal(transient.calls.length, 2);
    assert.equal(transient.logs.some((entry) => entry.event === 'wake_started'), true);

    const limited = harness({
      fetchImpl: async ({ body }) => {
        limited.calls.push({ body });
        return {
          status: 429,
          bodyText: 'Automation run rate limit exceeded',
          retryAfterMs: 60000,
        };
      },
    });
    await limited.wake.notify('51');
    await limited.timers[0].fn();
    assert.equal(limited.calls.length, 1);
    const before = limited.calls.length;
    await limited.timers.at(-1).fn();
    assert.equal(limited.calls.length, before);
    limited.setNow(1_000_000 + 60000);
    await limited.timers.at(-1).fn();
    assert.equal(limited.calls.length, 2);
    assert.equal(limited.logs.some((entry) => entry.event === 'wake_rate_limited_stop'), true);
    const afterStop = limited.timers.length;
    await limited.wake.flush();
    assert.equal(limited.calls.length, 2);
    assert.ok(limited.timers.length <= afterStop + 1);
  });

  it('defers locally once the per-routine hourly cap is reached', async () => {
    const { wake, calls } = harness({ maxPerHour: 2, maxBatch: 1, quietMs: 1500 });
    await wake.notify('61');
    await wake.notify('62');
    const third = await wake.notify('63');
    assert.equal(calls.length, 2);
    assert.equal(third.deferred, true);
    assert.equal(calls.some((call) => call.body.msgId === '63' || (call.body.msgIds || []).includes('63')), false);
  });

  it('skips the POST when the webhook env is missing and never puts the key in the error', async () => {
    const logs = [];
    const wake = new WakeHandoff({
      url: '',
      key: '',
      log: (entry) => logs.push(entry),
    });
    const result = await wake.notify('71');
    assert.equal(result.skipped, true);
    assert.equal(logs[0].reason, 'missing_env');
    await assert.rejects(
      postWebhook({ url: 'not a url', key: 'test-webhook-key', body: { msgId: '1' } }),
      (err) => {
        assert.equal(err.message, 'invalid webhook url');
        assert.equal(err.message.includes('test-webhook-key'), false);
        return true;
      },
    );
  });

  it('posts JSON with a bearer token through the HTTP client without opening a socket', async () => {
    const original = https.request;
    let captured = null;
    let written = '';
    https.request = (opts, callback) => {
      captured = opts;
      const req = {
        on() { return req; },
        write(buf) { written += buf.toString(); },
        end() {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          process.nextTick(() => res.emit('end'));
        },
        destroy() {},
      };
      return req;
    };
    try {
      const response = await postWebhook({
        url: 'https://hooks.example/wake',
        key: 'test-webhook-key',
        body: { msgId: '81' },
      });
      assert.equal(response.status, 200);
      assert.equal(captured.method, 'POST');
      assert.equal(captured.headers.Authorization, 'Bearer test-webhook-key');
      assert.equal(written, '{"msgId":"81"}');
    } finally {
      https.request = original;
    }
  });
});
