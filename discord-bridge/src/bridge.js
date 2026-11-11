'use strict';

const fs = require('fs');
const path = require('path');
const { evaluate, RateLimiter, replyChannelAllowed } = require('./policy');
const { FileQueue } = require('./queue');
const { WakeHandoff } = require('./wake');
const { chunkReply } = require('./chunk');
const { redact, hashId } = require('./redact');
const { createLogger } = require('./log');
const { loadConfig, assertReady, expandHome } = require('./config');
const { trackGateway } = require('./reconnect');

const ALLOWED_MENTIONS = Object.freeze({ parse: [] });
const FAILURE_NOTICE = "Couldn't answer that one. It's logged.";
const TIMEOUT_NOTICE = 'Still working on this. If nothing else arrives, try again later.';

function stripBotMention(text, botId) {
  if (!botId) return String(text || '');
  return String(text || '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function rateLimitDelay(err) {
  if (!err) return null;
  const status = err.status || err.statusCode || err.httpStatus;
  const limited = status === 429 || err.name === 'RateLimitError';
  if (!limited) return null;
  if (typeof err.timeout === 'number') return err.timeout;
  if (typeof err.retryAfter === 'number') return Math.ceil(err.retryAfter * 1000);
  return 1000;
}

async function defaultResolveMessage(client, channelId, messageId) {
  if (!client || !client.channels || typeof client.channels.fetch !== 'function') {
    throw new Error('cannot resolve message');
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') {
    throw new Error('cannot resolve message');
  }
  return channel.messages.fetch(messageId);
}

class Bridge {
  constructor(options) {
    this.client = options.client;
    this.config = options.config;
    this.queue = options.queue;
    this.wake = options.wake;
    this.log = options.log;
    this.rates = options.rateLimits || new RateLimiter(this.config.policy.rateLimits);
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
    }));
    this.resolveMessage = options.resolveMessage || defaultResolveMessage;
    this.intervalMs = options.intervalMs || 1000;
    this.timer = null;
  }

  botId() {
    if (this.client && this.client.user && this.client.user.id) return String(this.client.user.id);
    if (this.config.discord && this.config.discord.botUserId) return String(this.config.discord.botUserId);
    return '';
  }

  killSwitchOn() {
    try {
      return fs.existsSync(this.config.features.killSwitchFile);
    } catch (err) {
      return false;
    }
  }

  tripKillSwitch() {
    const file = this.config.features.killSwitchFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `tripped ${new Date(this.now()).toISOString()}\n`, { mode: 0o600 });
  }

  silenced() {
    return !this.config.features || this.config.features.enabled !== true || this.killSwitchOn();
  }

  buildRecord(message, decision) {
    const botId = this.botId();
    const name = (message.member && message.member.displayName) || (message.author && message.author.username) || '';
    return {
      id: String(message.id),
      discordMessageId: String(message.id),
      channelId: String(decision.channelId),
      parentChannelId: decision.parentId ? String(decision.parentId) : null,
      guildId: String(decision.guildId),
      authorIdHash: hashId(message.author.id),
      authorDisplayName: String(name).slice(0, 64),
      text: redact(stripBotMention(message.content || '', botId)).slice(0, 4000),
      createdTimestamp: message.createdTimestamp || this.now(),
      enqueuedAt: new Date(this.now()).toISOString(),
    };
  }

  async react(message, emoji) {
    if (!emoji || !message || typeof message.react !== 'function') return;
    try {
      await message.react(emoji);
    } catch (err) {
      this.log.warn({ event: 'react_failed', messageId: message.id });
    }
  }

  async replyWithRetry(message, content) {
    const payload = { content, allowedMentions: ALLOWED_MENTIONS };
    let attempts = 0;
    let rateWaits = 0;
    let last = null;
    while (attempts < 3) {
      try {
        return await message.reply(payload);
      } catch (err) {
        last = err;
        const delay = rateLimitDelay(err);
        if (delay != null && rateWaits < 5) {
          rateWaits += 1;
          await this.sleep(delay);
          continue;
        }
        attempts += 1;
        if (attempts >= 3) break;
        await this.sleep(Math.min(1000 * (2 ** (attempts - 1)), 8000));
      }
    }
    throw last || new Error('send failed');
  }

  async handleMessage(message) {
    try {
      const decision = evaluate(message, this.config, {
        botId: this.botId(),
        killSwitchOn: this.killSwitchOn(),
        rateLimits: this.rates,
        now: this.now(),
      });
      if (!decision.allow) {
        if (decision.reason !== 'prefix_command') this.log.audit(decision.reason, message);
        if (decision.reason === 'rate_limited_global') this.tripKillSwitch();
        return { accepted: false, reason: decision.reason };
      }
      const id = String(message.id);
      if (this.queue.seen(id)) {
        this.log.audit('duplicate', message);
        return { accepted: false, reason: 'duplicate' };
      }
      const queued = this.queue.enqueue(this.buildRecord(message, decision));
      if (!queued.ok) {
        this.log.audit('duplicate', message);
        return { accepted: false, reason: 'duplicate' };
      }
      this.rates.commit(message.author.id, decision.channelId, this.now());
      const reactions = this.config.policy.reactions || {};
      if (reactions.enabled) await this.react(message, reactions.ack);
      await this.wake.notify(id);
      return { accepted: true, id };
    } catch (err) {
      this.log.error({ event: 'handle_error' });
      return { accepted: false, reason: 'error' };
    }
  }

  async flushOutbox() {
    if (this.silenced()) return { skipped: true };
    const ranked = this.queue.list('outbox').map((id) => {
      const inbox = this.queue.read('inbox', id);
      return {
        id,
        created: inbox && inbox.createdTimestamp ? inbox.createdTimestamp : 0,
      };
    }).sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
    const results = [];
    for (const item of ranked) results.push(await this.deliverOne(item.id));
    return results;
  }

  async deliverOne(id) {
    if (this.silenced()) return { skipped: true };
    const reply = this.queue.read('outbox', id);
    if (!reply) return { missing: true };
    const replyTo = String(reply.replyTo || '');
    if (replyTo !== String(id)) {
      this.queue.fail(id, { error: 'reply_id_mismatch' });
      return { dead: true, reason: 'reply_id_mismatch' };
    }
    if (reply.final === false) return { waiting: true };
    if (reply.nextAttemptAt && this.now() < Date.parse(reply.nextAttemptAt)) return { waiting: true };

    const inbox = this.queue.read('inbox', replyTo);
    if (!inbox) {
      this.queue.fail(replyTo, { error: 'missing_inbox' });
      return { dead: true, reason: 'missing_inbox' };
    }
    if (String(reply.channelId) !== String(inbox.channelId)) {
      this.queue.fail(replyTo, { error: 'channel_mismatch' });
      return { dead: true, reason: 'channel_mismatch' };
    }
    if (!replyChannelAllowed(this.config, reply.channelId, inbox.parentChannelId)) {
      this.queue.fail(replyTo, { error: 'channel_denied' });
      return { dead: true, reason: 'channel_denied' };
    }

    const chunks = chunkReply(
      redact(reply.text || ''),
      this.config.policy.maxReplyChars || 1900,
      this.config.policy.maxReplyChunks || 3,
    ).filter((chunk) => chunk.trim().length > 0);

    let message = null;
    try {
      message = await this.resolveMessage(this.client, inbox.channelId, replyTo);
      for (const chunk of chunks) {
        await this.replyWithRetry(message, chunk);
      }
      await this.swapReaction(message);
      this.queue.complete(replyTo, { chunks: chunks.length });
      return { done: true, chunks: chunks.length };
    } catch (err) {
      try {
        if (message && typeof message.reply === 'function') {
          await message.reply({ content: FAILURE_NOTICE, allowedMentions: ALLOWED_MENTIONS });
        }
        if (message) await this.react(message, (this.config.policy.reactions || {}).fail);
      } catch (noticeErr) {
        this.log.warn({ event: 'failure_notice_failed', messageId: replyTo });
      }
      this.queue.fail(replyTo, { error: 'send_failed' });
      return { dead: true, reason: 'send_failed' };
    }
  }

  async swapReaction(message) {
    const reactions = this.config.policy.reactions || {};
    if (!reactions.enabled) return;
    await this.react(message, reactions.done);
    try {
      const cache = message.reactions && message.reactions.cache;
      const existing = cache && typeof cache.get === 'function' ? cache.get(reactions.ack) : null;
      if (existing && existing.users && this.client && this.client.user) {
        await existing.users.remove(this.client.user.id);
      }
    } catch (err) {
      this.log.warn({ event: 'react_clear_failed', messageId: message && message.id });
    }
  }

  async checkTimeouts() {
    if (this.silenced()) return;
    const minutes = Number(this.config.policy.commsTimeoutMinutes || 0);
    if (!minutes) return;
    const limit = minutes * 60 * 1000;
    for (const item of this.queue.listRecords('inbox')) {
      if (!item || item.timeoutNotified) continue;
      if (this.queue.exists('outbox', item.discordMessageId)) continue;
      const enqueued = Date.parse(item.enqueuedAt);
      if (!Number.isFinite(enqueued) || this.now() - enqueued < limit) continue;
      try {
        const message = await this.resolveMessage(this.client, item.channelId, item.discordMessageId);
        await this.replyWithRetry(message, TIMEOUT_NOTICE);
      } catch (err) {
        this.log.warn({ event: 'timeout_notice_failed', messageId: item.discordMessageId });
      }
      item.timeoutNotified = true;
      this.queue.overwrite('inbox', item.discordMessageId, item);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flushOutbox().catch(() => this.log.error({ event: 'flush_error' }));
      this.checkTimeouts().catch(() => this.log.error({ event: 'timeout_error' }));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.wake) this.wake.stop();
  }
}

function attachToClient(client, options = {}) {
  let loaded;
  if (options.config) {
    loaded = { config: options.config, localPath: options.localPath || null };
  } else {
    loaded = loadConfig(options);
  }
  const config = loaded.config;
  if (config.features.enabled) assertReady(config, { localPath: loaded.localPath });

  const queue = options.queue || new FileQueue(expandHome(config.queue.dir));
  const log = options.log || createLogger({
    level: config.logging.level,
    dir: expandHome(config.logging.dir),
    logBodies: config.logging.logBodies,
  });
  const wake = options.wake || new WakeHandoff({
    url: process.env[config.wake.urlEnv] || '',
    key: process.env[config.wake.keyEnv] || '',
    quietMs: config.wake.coalesceQuietMs,
    maxBatch: config.wake.coalesceMaxBatch,
    maxPerHour: config.wake.maxPerHour,
    log: (entry) => log.info(entry),
    fetchImpl: options.fetchImpl,
    schedule: options.schedule,
    now: options.now,
  });
  const bridge = new Bridge({
    client,
    config,
    queue,
    log,
    wake,
    now: options.now,
    sleep: options.sleep,
    resolveMessage: options.resolveMessage,
    rateLimits: options.rateLimits,
    intervalMs: options.intervalMs,
  });
  const prefixes = options.ignorePrefixes || config.policy.ignorePrefixes || ['!!'];
  const listener = (msg) => {
    if (msg && typeof msg.content === 'string' && prefixes.some((prefix) => prefix && msg.content.startsWith(prefix))) {
      return undefined;
    }
    return bridge.handleMessage(msg);
  };
  client.on('messageCreate', listener);
  bridge.listener = listener;
  trackGateway(client, log);
  if (options.autostart !== false && config.features.enabled) bridge.start();
  bridge.detach = () => {
    client.removeListener('messageCreate', listener);
    bridge.stop();
  };
  return bridge;
}

module.exports = {
  ALLOWED_MENTIONS,
  FAILURE_NOTICE,
  TIMEOUT_NOTICE,
  Bridge,
  attachToClient,
  stripBotMention,
  rateLimitDelay,
};
