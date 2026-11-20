'use strict';

const fs = require('fs');
const path = require('path');
const { errorFields } = require('./log');

const SNOWFLAKE = /^\d{17,20}$/;
const PAGE = 50;
const MAX_PAGES = 4;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 65000;
const MAX_RETRIES = 5;

function newer(a, b) {
  if (!b) return true;
  return BigInt(a) > BigInt(b);
}

/**
 * Remembers the newest message id seen per allowed channel, and after a gateway
 * READY or RESUME fetches what arrived while the bridge was not connected.
 * Every fetched message goes through the same listener as a live one, so
 * requireMention, the allowlists, rate limits, the kill switch and the
 * duplicate check all still apply. Message text is never logged here.
 */
class Backfill {
  constructor(options) {
    this.client = options.client;
    this.log = options.log;
    this.handle = options.handle;
    this.channelIds = (options.channelIds || []).filter((id) => SNOWFLAKE.test(String(id))).map(String);
    this.file = options.cursorFile;
    this.botId = options.botId || (() => null);
    this.rateCheck = options.rateCheck || null;
    this.killSwitchOn = options.killSwitchOn || (() => false);
    this.now = options.now || Date.now;
    this.maxAgeMs = options.maxAgeMs || MAX_AGE_MS;
    this.retryMs = options.retryMs || RETRY_MS;
    this.schedule = options.schedule || ((fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    });
    this.cursor = this.load();
    this.running = null;
    this.retries = 0;
    this.retryTimer = null;
    this.stopped = false;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const out = {};
      for (const id of this.channelIds) {
        if (data && data.channels && SNOWFLAKE.test(String(data.channels[id] || ''))) out[id] = String(data.channels[id]);
      }
      return out;
    } catch (err) {
      return {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ channels: this.cursor })}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn({ event: 'backfill_cursor_save_failed', ...errorFields(err) });
    }
  }

  /** Call for every live message. Only allowed channels move the cursor. */
  note(message) {
    if (!message || !SNOWFLAKE.test(String(message.id || ''))) return;
    const channelId = String(message.channelId || (message.channel && message.channel.id) || '');
    if (!this.channelIds.includes(channelId)) return;
    if (newer(String(message.id), this.cursor[channelId])) {
      this.cursor[channelId] = String(message.id);
      this.save();
    }
  }

  trigger(why) {
    if (this.stopped) return Promise.resolve(null);
    if (this.running) return this.running;
    this.running = this.run(why).finally(() => { this.running = null; });
    return this.running;
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  mentionsBot(message) {
    const botId = this.botId();
    const users = message && message.mentions && message.mentions.users;
    return Boolean(botId && users && typeof users.has === 'function' && users.has(botId));
  }

  async fetchAfter(channel, after) {
    const out = [];
    let cursor = after;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await channel.messages.fetch({ after: cursor, limit: PAGE });
      const list = [...(batch && typeof batch.values === 'function' ? batch.values() : [])];
      if (list.length === 0) break;
      list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      out.push(...list);
      cursor = list[list.length - 1].id;
      if (list.length < PAGE) break;
    }
    out.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return out;
  }

  async run(why) {
    const summary = { why, channels: 0, fetched: 0, handled: 0, accepted: 0, skippedOld: 0, deferred: false };
    if (this.killSwitchOn()) {
      this.log.info({ event: 'backfill_skipped', reason: 'kill_switch' });
      return summary;
    }
    for (const channelId of this.channelIds) {
      let channel;
      try {
        channel = await this.client.channels.fetch(channelId);
      } catch (err) {
        this.log.warn({ event: 'backfill_failed', channelId, step: 'channel', ...errorFields(err) });
        continue;
      }
      if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') continue;
      summary.channels += 1;
      const after = this.cursor[channelId];
      if (!after) {
        // First run for this channel: start from now. Older history is not replayed.
        try {
          const latest = await channel.messages.fetch({ limit: 1 });
          const first = latest && typeof latest.first === 'function' ? latest.first() : null;
          if (first && first.id) {
            this.cursor[channelId] = String(first.id);
            this.save();
          }
        } catch (err) {
          this.log.warn({ event: 'backfill_failed', channelId, step: 'seed', ...errorFields(err) });
        }
        continue;
      }
      let messages;
      try {
        messages = await this.fetchAfter(channel, after);
      } catch (err) {
        this.log.warn({ event: 'backfill_failed', channelId, step: 'fetch', ...errorFields(err) });
        continue;
      }
      summary.fetched += messages.length;
      for (const message of messages) {
        if (this.stopped) break;
        const created = Number(message.createdTimestamp) || 0;
        const candidate = !(message.author && message.author.bot) && this.mentionsBot(message);
        if (candidate && created && this.now() - created > this.maxAgeMs) {
          summary.skippedOld += 1;
          this.log.info({ event: 'backfill_too_old', channelId, messageId: String(message.id) });
        } else if (candidate) {
          if (this.rateCheck) {
            const rate = this.rateCheck(message);
            if (rate && rate.ok === false) {
              // Leave the cursor before this message and try again after the window passes.
              summary.deferred = true;
              this.log.info({ event: 'backfill_deferred', channelId, reason: rate.reason });
              break;
            }
          }
          let result;
          try {
            result = await this.handle(message);
          } catch (err) {
            this.log.warn({ event: 'backfill_handle_failed', channelId, ...errorFields(err) });
          }
          summary.handled += 1;
          if (result && result.accepted) summary.accepted += 1;
          if (result && typeof result.reason === 'string' && result.reason.startsWith('rate_limited')) {
            summary.deferred = true;
            break;
          }
        }
        if (newer(String(message.id), this.cursor[channelId])) this.cursor[channelId] = String(message.id);
      }
      this.save();
      if (summary.deferred) break;
    }
    this.log.info({ event: 'backfill_done', ...summary });
    if (summary.deferred && !this.stopped && this.retries < MAX_RETRIES) {
      this.retries += 1;
      this.retryTimer = this.schedule(() => { this.retryTimer = null; this.trigger('retry'); }, this.retryMs);
    } else if (!summary.deferred) {
      this.retries = 0;
    }
    return summary;
  }
}

module.exports = { Backfill, MAX_AGE_MS };
