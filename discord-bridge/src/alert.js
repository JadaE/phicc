'use strict';

const fs = require('fs');
const path = require('path');
const { postWebhook } = require('./wake');

class Alerter {
  constructor(options = {}) {
    this.dir = options.dir;
    this.url = options.url || '';
    this.key = options.key || '';
    this.fetchImpl = options.fetchImpl;
    this.log = options.log || (() => {});
  }

  async send(entry) {
    const payload = {
      level: entry.level || 'P0',
      reason: String(entry.reason || 'alert'),
      detail: entry.detail ? String(entry.detail).slice(0, 80) : undefined,
      at: entry.at || new Date().toISOString(),
      guildId: entry.guildId || null,
      channelId: entry.channelId || null,
      messageId: entry.messageId || null,
    };
    this.writeFile(payload);
    if (!this.url || !this.key) return payload;
    try {
      await postWebhook({
        url: this.url,
        key: this.key || 'alert',
        body: payload,
        transport: this.fetchImpl,
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

module.exports = { Alerter };
