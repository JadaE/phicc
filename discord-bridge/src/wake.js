'use strict';

const https = require('https');

const HOUR_MS = 60 * 60 * 1000;

function webhookError(message, code) {
  const error = new Error(message);
  error.name = 'WebhookError';
  error.code = code;
  return error;
}

function parseHttpsWebhook(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw webhookError('invalid webhook url', 'WEBHOOK_URL');
  }
  if (parsed.protocol !== 'https:') {
    throw webhookError('webhook url must be https', 'WEBHOOK_HTTPS');
  }
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname)) {
    throw webhookError('webhook host is not allowed', 'WEBHOOK_HOST');
  }
  return parsed;
}

function postWebhook({ url, key, body, timeoutMs = 10000, transport, allowedHosts }) {
  let parsed;
  try {
    parsed = parseHttpsWebhook(url, allowedHosts);
  } catch (err) {
    return Promise.reject(err);
  }
  if (transport) return transport({ url, key, body, timeoutMs });
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const lib = https;
    const req = lib.request({
      method: 'POST',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: `Bearer ${key}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const retryHeader = res.headers && res.headers['retry-after'];
        let retryAfterMs = 0;
        if (retryHeader != null && retryHeader !== '') {
          const seconds = Number(retryHeader);
          if (Number.isFinite(seconds)) retryAfterMs = Math.ceil(seconds * 1000);
        }
        resolve({
          status: res.statusCode,
          bodyText: Buffer.concat(chunks).toString('utf8').slice(0, 300),
          retryAfterMs,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('webhook timeout'));
    });
    req.on('error', () => reject(new Error('webhook request failed')));
    req.write(payload);
    req.end();
  });
}

class WakeHandoff {
  constructor(options = {}) {
    this.url = options.url || '';
    this.key = options.key || '';
    this.quietMs = options.quietMs == null ? 1500 : options.quietMs;
    this.maxBatch = options.maxBatch || 5;
    this.maxPerHour = options.maxPerHour || 200;
    this.fetchImpl = options.fetchImpl || postWebhook;
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.clear = options.clear || ((timer) => clearTimeout(timer));
    this.now = options.now || (() => Date.now());
    this.log = options.log || (() => {});
    this.pending = [];
    this.timer = null;
    this.successes = [];
    this.inFlight = null;
    this.attempt = 0;
    this.rateLimitedOnce = false;
    this.holdUntil = 0;
    this.stopped = false;
    this.isStopped = options.isStopped || (() => false);
    this.giveUpRetryMs = options.giveUpRetryMs == null ? 60000 : options.giveUpRetryMs;
    this.allowedHosts = options.allowedHosts || null;
  }

  configured() {
    return Boolean(this.url && this.key);
  }

  notify(msgId) {
    if (!this.configured()) {
      this.log({ event: 'wake_skipped', reason: 'missing_env' });
      return Promise.resolve({ skipped: true });
    }
    if (this.stopped || this.isStopped()) {
      this.pending = [];
      return Promise.resolve({ stopped: true });
    }
    if (!this.pending.includes(msgId)) this.pending.push(msgId);
    if (this.pending.length >= this.maxBatch) {
      this.clearTimer();
      return this.flush();
    }
    this.arm(this.quietMs);
    return Promise.resolve({ coalescing: true });
  }

  arm(ms) {
    if (this.timer) return;
    const wait = Math.max(0, ms);
    this.timer = this.schedule(() => {
      this.timer = null;
      return this.flush().catch(() => {
        this.log({ event: 'wake_error' });
      });
    }, wait);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  clearTimer() {
    if (!this.timer) return;
    this.clear(this.timer);
    this.timer = null;
  }

  flush() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.flushNow().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async flushNow() {
    if (this.stopped || this.isStopped()) {
      this.pending = [];
      return { stopped: true };
    }
    if (this.pending.length === 0) return { empty: true };
    const now = this.now();
    this.successes = this.successes.filter((stamp) => now - stamp < HOUR_MS);
    if (now < this.holdUntil || this.successes.length >= this.maxPerHour) {
      const windowWait = this.successes.length
        ? (HOUR_MS - (now - this.successes[0]))
        : 0;
      const wait = Math.max(this.holdUntil - now, windowWait, 1000);
      this.log({ event: 'wake_deferred', reason: 'rate_limit', waitMs: wait });
      this.arm(wait);
      return { deferred: true, waitMs: wait };
    }

    const batch = this.pending.splice(0, this.maxBatch);
    const body = batch.length === 1 ? { msgId: batch[0] } : { msgIds: batch };
    let response;
    try {
      response = await this.fetchImpl({
        url: this.url,
        key: this.key,
        body,
        allowedHosts: this.allowedHosts,
      });
    } catch (err) {
      return this.failTransient(batch, 0);
    }
    const status = response && response.status;
    const bodyText = response && response.bodyText ? String(response.bodyText) : '';
    if (status === 200) {
      this.successes.push(this.now());
      this.attempt = 0;
      this.rateLimitedOnce = false;
      this.log({ event: 'wake_started', status: 200, count: batch.length });
      if (typeof this.onStarted === 'function') this.onStarted(batch);
      if (this.pending.length > 0) this.arm(this.quietMs);
      return { started: true, count: batch.length };
    }
    const rateLimited = status === 429 || /rate limit/i.test(bodyText);
    if (rateLimited) {
      this.pending = batch.concat(this.pending.filter((id) => !batch.includes(id)));
      const wait = Math.min(
        Math.max((response && response.retryAfterMs) || 60000, 1000),
        15 * 60 * 1000,
      );
      this.holdUntil = this.now() + wait;
      if (!this.rateLimitedOnce) {
        this.rateLimitedOnce = true;
        this.log({ event: 'wake_backoff', status: status || 0, waitMs: wait });
        this.arm(wait);
        return { backoff: true, waitMs: wait };
      }
      this.log({ event: 'wake_rate_limited_stop', status: status || 0 });
      return { stopped: true };
    }
    return this.failTransient(batch, status || 0);
  }

  failTransient(batch, status) {
    this.attempt += 1;
    if (this.attempt <= 5) {
      this.pending = batch.concat(this.pending.filter((id) => !batch.includes(id)));
      const wait = Math.min(1000 * (2 ** (this.attempt - 1)), 60000);
      this.log({ event: 'wake_backoff', status, attempt: this.attempt, waitMs: wait });
      this.arm(wait);
      return { backoff: true, waitMs: wait, attempt: this.attempt };
    }
    this.attempt = 0;
    this.pending = batch.concat(this.pending.filter((id) => !batch.includes(id)));
    this.log({ event: 'wake_gave_up', status, count: batch.length, requeued: true });
    this.arm(this.giveUpRetryMs);
    return { gaveUp: true, requeued: true };
  }

  stop() {
    this.stopped = true;
    this.clearTimer();
  }
}

module.exports = {
  WakeHandoff,
  postWebhook,
  parseHttpsWebhook,
  HOUR_MS,
};
