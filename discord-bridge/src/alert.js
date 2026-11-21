'use strict';

const fs = require('fs');
const path = require('path');
const { postWebhook } = require('./wake');

const SNOWFLAKE = /^\d{17,20}$/;

function fieldOrNone(value) {
  if (value == null || value === '') return 'none';
  const text = String(value);
  return SNOWFLAKE.test(text) ? text : 'none';
}

function alertTemplate(entry) {
  const reason = /^[a-z_]{1,40}$/.test(entry.reason || '') ? entry.reason : 'malformed';
  const at = typeof entry.at === 'string' && entry.at.length <= 40 ? entry.at : 'none';
  const count = Number.isInteger(entry.count) && entry.count > 1 && entry.count <= 1000000
    ? ` ${entry.count} similar alerts were coalesced.`
    : '';
  return `P0 Discord bridge alert: ${reason} (message ${fieldOrNone(entry.messageId)}, channel ${fieldOrNone(entry.channelId)}) at ${at}.${count} No content included. No action was taken. The operator decides what happens next.`;
}

class Alerter {
  constructor(options = {}) {
    this.dir = options.dir;
    this.url = options.url || '';
    this.key = options.key || '';
    this.allowedHosts = options.allowedHosts || [];
    this.fetchImpl = options.fetchImpl;
    this.log = options.log || (() => {});
  }

  async send(entry) {
    const payload = {
      level: 'P0',
      reason: /^[a-z_]{1,40}$/.test(entry.reason || '') ? entry.reason : 'malformed',
      at: entry.at || new Date().toISOString(),
      channelId: fieldOrNone(entry.channelId),
      messageId: fieldOrNone(entry.messageId),
    };
    if (Number.isInteger(entry.count) && entry.count >= 1 && entry.count <= 1000000) {
      payload.count = entry.count;
    }
    this.writeFile(payload);
    if (!this.url || !this.key) return payload;
    const text = alertTemplate(payload);
    try {
      await postWebhook({
        url: this.url,
        key: this.key,
        body: { text },
        transport: this.fetchImpl,
        allowedHosts: this.allowedHosts,
      });
    } catch (err) {
      this.log({ event: 'alert_post_failed', name: err && err.name, code: err && err.code });
    }
    return payload;
  }

  writeFile(payload) {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    try { fs.chmodSync(this.dir, 0o700); } catch (err) { /* best effort */ }
    const name = `${Date.now()}-${payload.reason}-${Math.random().toString(16).slice(2, 8)}.json`;
    const dest = path.join(this.dir, name);
    if (path.resolve(dest) !== path.join(path.resolve(this.dir), name)) return;
    fs.writeFileSync(dest, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  }
}

module.exports = { Alerter, alertTemplate };
