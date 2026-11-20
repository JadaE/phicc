'use strict';

const https = require('https');
const { redactValue } = require('./redact');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FAILED_ATTEMPTS = 8;

function clampAttempts(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MAX_FAILED_ATTEMPTS;
  return Math.min(30, Math.max(1, Math.floor(number)));
}

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
    this.allowSend = options.allowSend;
    this.deferFor = options.deferFor;
    this.giveUpRetryMs = options.giveUpRetryMs == null ? 60000 : options.giveUpRetryMs;
    this.allowedHosts = options.allowedHosts || null;
    this.carryRecord = options.carryRecord === true;
    this.recordFor = options.recordFor;
    this.maxFailedAttempts = options.maxFailedAttempts == null
      ? DEFAULT_MAX_FAILED_ATTEMPTS
      : clampAttempts(options.maxFailedAttempts);
    this.failures = new Map();
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
      this.discardPending([msgId]);
      return Promise.resolve({ stopped: true });
    }
    if ((this.failures.get(String(msgId)) || 0) >= this.maxFailedAttempts) {
      return Promise.resolve({ abandoned: true });
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

  spendWait(ids) {
    const hinted = typeof this.deferFor === 'function' ? Number(this.deferFor(ids)) : 60000;
    return Math.max(1000, Number.isFinite(hinted) ? hinted : 60000);
  }

  deferSpend(ids) {
    const keys = new Set(ids.map(String));
    const rest = this.pending.filter((id) => !keys.has(String(id)));
    this.pending = ids.concat(rest);
    const wait = this.spendWait(ids);
    this.log({ event: 'wake_deferred', reason: 'spend_cap', waitMs: wait });
    this.clearTimer();
    this.arm(wait);
    return { deferred: true, reason: 'spend_cap', waitMs: wait };
  }

  chooseBatch(batch) {
    if (typeof this.allowSend !== 'function') {
      return { sending: batch, held: [] };
    }
    const decision = this.allowSend(batch);
    if (!decision || decision === false) return { deferAll: true };
    if (typeof decision !== 'object') return { sending: batch, held: [] };
    const sendSet = new Set((decision.send || []).map(String));
    const sending = batch.filter((id) => sendSet.has(String(id)));
    const held = batch.filter((id) => !sendSet.has(String(id)));
    if (sending.length === 0) return { deferAll: true };
    return { sending, held };
  }

  holdBack(ids) {
    if (!ids || ids.length === 0) return;
    const keys = new Set(ids.map(String));
    const rest = this.pending.filter((id) => !keys.has(String(id)));
    this.pending = ids.concat(rest);
  }

  buildBody(sending) {
    if (this.carryRecord !== true) {
      return sending.length === 1 ? { msgId: sending[0] } : { msgIds: sending };
    }
    const cap = this.maxBatch || 5;
    const items = [];
    for (const id of sending) {
      if (items.length >= cap) break;
      let raw = null;
      if (typeof this.recordFor === 'function') raw = this.recordFor(id);
      const item = sanitizeWakeItem(raw, id);
      if (item) items.push(item);
    }
    return { v: 1, items };
  }

  armAfterSend(held) {
    if (this.pending.length === 0) return;
    const heldKeys = new Set((held || []).map(String));
    const onlyHeld = heldKeys.size > 0 && this.pending.every((id) => heldKeys.has(String(id)));
    if (!onlyHeld) {
      this.arm(this.quietMs);
      return;
    }
    const wait = this.spendWait(this.pending);
    this.log({ event: 'wake_deferred', reason: 'spend_cap', waitMs: wait });
    this.clearTimer();
    this.arm(wait);
  }

  discardPending(extra) {
    this.clearTimer();
    const seen = new Set();
    const ids = [];
    const push = (id) => {
      if (id == null || id === '') return;
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);
      ids.push(key);
    };
    for (const id of this.pending) push(id);
    this.pending = [];
    if (Array.isArray(extra)) {
      for (const id of extra) push(id);
    }
    for (const id of ids) this.failures.delete(id);
    if (ids.length > 0 && typeof this.onDropped === 'function') this.onDropped(ids);
    return ids;
  }

  async flushNow() {
    if (this.stopped || this.isStopped()) {
      this.discardPending();
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
    const choice = this.chooseBatch(batch);
    if (choice.deferAll) return this.deferSpend(batch);
    const sending = choice.sending;
    const held = choice.held || [];
    this.holdBack(held);
    const body = this.buildBody(sending);
    let response;
    try {
      response = await this.fetchImpl({
        url: this.url,
        key: this.key,
        body,
        allowedHosts: this.allowedHosts,
      });
    } catch (err) {
      return this.failTransient(sending, 0);
    }
    const status = response && response.status;
    const bodyText = response && response.bodyText ? String(response.bodyText) : '';
    if (status === 200) {
      for (const id of sending) this.failures.delete(String(id));
      this.successes.push(this.now());
      this.attempt = 0;
      this.rateLimitedOnce = false;
      this.log({ event: 'wake_started', status: 200, count: sending.length });
      if (typeof this.onStarted === 'function') this.onStarted(sending);
      this.armAfterSend(held);
      return { started: true, count: sending.length };
    }
    const rateLimited = status === 429 || /rate limit/i.test(bodyText);
    if (rateLimited) {
      const keys = new Set(sending.map(String));
      this.pending = sending.concat(this.pending.filter((id) => !keys.has(String(id))));
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
    return this.failTransient(sending, status || 0);
  }

  failTransient(batch, status) {
    const keep = [];
    const dropped = [];
    for (const id of batch) {
      const key = String(id);
      const prev = this.failures.get(key) || 0;
      if (prev >= this.maxFailedAttempts) {
        dropped.push(key);
        continue;
      }
      const count = prev + 1;
      this.failures.set(key, count);
      if (count >= this.maxFailedAttempts) {
        dropped.push(key);
        this.log(redactValue({
          event: 'audit',
          reason: 'wake_abandoned',
          messageId: key,
          status: Number(status) || 0,
          attempts: count,
        }, 0));
      } else {
        keep.push(id);
      }
    }
    if (keep.length === 0) {
      this.attempt = 0;
      if (this.pending.length > 0) this.arm(this.quietMs);
      return { abandoned: true, dropped, status: Number(status) || 0 };
    }
    const requeue = () => {
      const keys = new Set(keep.map(String));
      this.pending = keep.concat(this.pending.filter((id) => !keys.has(String(id))));
    };
    this.attempt += 1;
    if (this.attempt <= 5) {
      requeue();
      const wait = Math.min(1000 * (2 ** (this.attempt - 1)), 60000);
      this.log({ event: 'wake_backoff', status, attempt: this.attempt, waitMs: wait });
      this.arm(wait);
      return { backoff: true, waitMs: wait, attempt: this.attempt, dropped };
    }
    this.attempt = 0;
    requeue();
    this.log({ event: 'wake_gave_up', status, count: keep.length, requeued: true });
    this.arm(this.giveUpRetryMs);
    return { gaveUp: true, requeued: true, dropped };
  }

  stop() {
    this.stopped = true;
    this.clearTimer();
  }
}

const WAKE_TEXT_CAP = 4000;

function sanitizeWakeItem(raw, id) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text == null ? '' : raw.text)
    .replace(/<@!?\d+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, WAKE_TEXT_CAP);
  return {
    msgId: String(raw.msgId || id),
    channelId: String(raw.channelId || ''),
    text,
    authorName: String(raw.authorName == null ? '' : raw.authorName).slice(0, 64),
    authorHash: String(raw.authorHash || ''),
    ts: Number(raw.ts) || 0,
    trust: 'untrusted_discord_content',
  };
}

module.exports = {
  WakeHandoff,
  postWebhook,
  parseHttpsWebhook,
  sanitizeWakeItem,
  WAKE_TEXT_CAP,
  HOUR_MS,
};
