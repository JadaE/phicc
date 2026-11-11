'use strict';

const fs = require('fs');
const path = require('path');
const { evaluate, RateLimiter, replyChannelAllowed, botMentioned, isListed, channelAllowed } = require('./policy');
const { FileQueue } = require('./queue');
const { WakeHandoff } = require('./wake');
const { chunkReply } = require('./chunk');
const { redactSecrets } = require('./redact');
const { createLogger, errorFields } = require('./log');
const { loadConfig, assertReady, expandHome, clampConfig } = require('./config');
const { trackGateway } = require('./reconnect');
const { signRecord, verifyRecord } = require('./sign');
const { Alerter } = require('./alert');
const { BridgeLock } = require('./lock');

const ALLOWED_MENTIONS = Object.freeze({ parse: [] });
const FAILURE_NOTICE = "Couldn't answer that one. It's logged.";
const TIMEOUT_NOTICE = 'Still working on this. If nothing else arrives, try again later.';
const QUIET_REASONS = new Set([
  'prefix_command',
  'ignore_bot',
  'ignore_self',
  'ignore_webhook',
  'disabled',
  'dm_blocked',
  'not_mention',
  'guild_denied',
  'channel_denied',
]);

function stripBotMention(text, botId) {
  if (!botId) return String(text || '');
  return String(text || '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function looksLikeInjection(text) {
  return /ignore (all |any |the )?(previous |prior )?(instructions|rules)/i.test(text)
    || /\byou are now\b/i.test(text)
    || /\bsystem prompt\b/i.test(text);
}

const OUTBOX_KEYS = new Set([
  'replyTo', 'channelId', 'text', 'final', 'sig', 'sentChunks', 'attempts', 'nextAttemptAt',
]);
const MAX_REWAKES = 2;

function stripOutbound(text) {
  return String(text)
    .replace(/https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/gi, '[link removed]')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|discord:\/\/)[^)]+\)/gi, '$1');
}

function isUnreachable(err) {
  if (!err || err.code == null) return false;
  const code = String(err.code);
  return code === '10008' || code === '10003' || code === '404';
}

function rewakeBackoff(count) {
  return Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, count - 1)));
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

function shouldAudit(message, config, reason, botId) {
  if (QUIET_REASONS.has(reason)) return false;
  if (!message || !botMentioned(message, botId)) return false;
  const guildId = message.guildId || (message.guild && message.guild.id) || null;
  if (!isListed(config.discord.guildIds, guildId)) return false;
  if (!channelAllowed(config, message).ok) return false;
  return true;
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
    this.flushing = false;
    this.ticking = false;
    this.stoppedLoop = false;
    this.stopAlerted = false;
    this.extraDenied = new Set();
    this.strikes = {};
    this.rewakes = {};
    this.hmacKey = options.hmacKey || '';
    this.token = options.token || '';
    this.tokenLockDir = options.tokenLockDir;
    this.useLock = options.lock !== false;
    this.secrets = (options.secrets || []).filter((secret) => typeof secret === 'string' && secret.length >= 8);
    this.alerter = options.alerter || new Alerter({
      dir: path.join(this.queue.root, 'alerts'),
      url: options.alertUrl || '',
      key: options.alertKey || '',
      allowedHosts: options.alertHosts || (this.config.wake && this.config.wake.allowedHosts) || [],
      fetchImpl: options.alertFetch,
      log: this.log,
    });
    this.loadRates();
    this.loadSecurity();
    this.loadRewakes();
    if (this.wake) {
      this.wake.isStopped = () => this.killSwitchOn();
      this.wake.allowSend = () => this.allowWake();
    }
  }

  outboxSigRequired() {
    return !this.config.queue || this.config.queue.requireOutboxSig !== false;
  }

  seal(record) {
    if (!this.hmacKey || !record) return record;
    const signed = signRecord(record, this.hmacKey);
    record.sig = signed.sig;
    return record;
  }

  allowWake() {
    const gate = this.rates.checkGlobal(this.now());
    if (!gate.ok) {
      this.tripKillSwitch(gate.reason);
      this.stopAlerted = true;
      return false;
    }
    this.rates.commitGlobal(this.now());
    this.saveRates();
    return true;
  }

  botId() {
    if (this.client && this.client.user && this.client.user.id) return String(this.client.user.id);
    if (this.config.discord && this.config.discord.botUserId) return String(this.config.discord.botUserId);
    return '';
  }

  decisionConfig() {
    const denied = new Set([
      ...(this.config.discord.deniedUserIds || []),
      ...this.extraDenied,
    ]);
    return {
      ...this.config,
      discord: { ...this.config.discord, deniedUserIds: [...denied] },
    };
  }

  redactText(text) {
    return redactSecrets(text, this.secrets);
  }

  killSwitchOn() {
    try {
      const file = this.config.features && this.config.features.killSwitchFile;
      if (!file || typeof file !== 'string') return true;
      return fs.existsSync(file);
    } catch (err) {
      return true;
    }
  }

  tripKillSwitch(detail) {
    const file = this.config.features.killSwitchFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `tripped ${new Date(this.now()).toISOString()}\n`, { mode: 0o600 });
    return this.alert({ level: 'P0', reason: 'kill_switch', detail: detail || 'tripped' });
  }

  noteKillSwitch() {
    if (!this.killSwitchOn()) {
      this.stopAlerted = false;
      return false;
    }
    if (!this.stopAlerted) {
      this.stopAlerted = true;
      this.alert({ level: 'P0', reason: 'kill_switch', detail: 'stop_file' });
    }
    return true;
  }

  silenced() {
    return !this.config.features || this.config.features.enabled !== true || this.killSwitchOn();
  }

  async alert(entry) {
    try {
      await this.alerter.send({ ...entry, at: new Date(this.now()).toISOString() });
    } catch (err) {
      this.log.warn({ event: 'alert_failed', ...errorFields(err) });
    }
  }

  ratePath() {
    return path.join(this.queue.root, 'state', 'rate.json');
  }

  securityPath() {
    return path.join(this.queue.root, 'state', 'security.json');
  }

  loadRates() {
    try {
      if (!fs.existsSync(this.ratePath())) return;
      this.rates.restore(JSON.parse(fs.readFileSync(this.ratePath(), 'utf8')));
    } catch (err) {
      this.log.warn({ event: 'rate_state_unreadable', ...errorFields(err) });
    }
  }

  saveRates() {
    const dir = path.dirname(this.ratePath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.ratePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.rates.snapshot())}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.ratePath());
    fs.chmodSync(this.ratePath(), 0o600);
  }

  loadSecurity() {
    try {
      if (!fs.existsSync(this.securityPath())) return;
      const data = JSON.parse(fs.readFileSync(this.securityPath(), 'utf8'));
      this.strikes = data.strikes || {};
      this.extraDenied = new Set(data.denied || []);
    } catch (err) {
      this.log.warn({ event: 'security_state_unreadable', ...errorFields(err) });
    }
  }

  saveSecurity() {
    const dir = path.dirname(this.securityPath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.securityPath()}.${process.pid}.tmp`;
    const payload = { strikes: this.strikes, denied: [...this.extraDenied] };
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.securityPath());
    fs.chmodSync(this.securityPath(), 0o600);
  }

  rewakePath() {
    return path.join(this.queue.root, 'state', 'rewakes.json');
  }

  loadRewakes() {
    try {
      if (!fs.existsSync(this.rewakePath())) return;
      const data = JSON.parse(fs.readFileSync(this.rewakePath(), 'utf8'));
      this.rewakes = data && typeof data === 'object' ? data : {};
    } catch (err) {
      this.log.warn({ event: 'rewake_state_unreadable', ...errorFields(err) });
    }
  }

  saveRewakes() {
    const dir = path.dirname(this.rewakePath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.rewakePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.rewakes)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.rewakePath());
    fs.chmodSync(this.rewakePath(), 0o600);
  }

  async requestRewake(id) {
    const rec = this.rewakes[id] || { count: 0, nextAt: 0 };
    if (rec.count >= MAX_REWAKES) return false;
    if (this.now() < Number(rec.nextAt || 0)) return false;
    const gate = this.rates.checkGlobal(this.now());
    if (!gate.ok) {
      await this.tripKillSwitch(gate.reason);
      this.stopAlerted = true;
      return false;
    }
    rec.count += 1;
    rec.nextAt = this.now() + rewakeBackoff(rec.count);
    this.rewakes[id] = rec;
    this.saveRewakes();
    if (this.wake && typeof this.wake.notify === 'function') await this.wake.notify(id);
    return true;
  }

  noteOutsider(userId) {
    if (!userId) return;
    this.strikes[userId] = (this.strikes[userId] || 0) + 1;
    if (this.strikes[userId] >= 3) this.extraDenied.add(String(userId));
    this.saveSecurity();
  }

  buildRecord(message, decision) {
    const botId = this.botId();
    const name = (message.member && message.member.displayName) || (message.author && message.author.username) || '';
    const text = this.redactText(stripBotMention(message.content || '', botId)).slice(0, 4000);
    return {
      trust: 'untrusted_discord_content',
      source: {
        kind: 'discord',
        messageId: String(message.id),
        channelId: String(decision.channelId),
        guildId: String(decision.guildId),
      },
      id: String(message.id),
      discordMessageId: String(message.id),
      channelId: String(decision.channelId),
      parentChannelId: decision.parentId ? String(decision.parentId) : null,
      guildId: String(decision.guildId),
      authorIdHash: this.queue.authorLabel(message.author.id),
      authorDisplayName: this.redactText(String(name).slice(0, 64)),
      text,
      injectionSuspected: looksLikeInjection(text),
      createdTimestamp: message.createdTimestamp || this.now(),
      enqueuedAt: new Date(this.now()).toISOString(),
    };
  }

  async react(message, emoji) {
    if (!emoji || !message || typeof message.react !== 'function') return;
    try {
      await message.react(emoji);
    } catch (err) {
      this.log.warn({ event: 'react_failed', messageId: message.id, ...errorFields(err) });
    }
  }

  async replyWithRetry(message, content) {
    const payload = { content: this.redactText(content), allowedMentions: ALLOWED_MENTIONS };
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
      if (this.noteKillSwitch()) return { accepted: false, reason: 'kill_switch' };
      const config = this.decisionConfig();
      const decision = evaluate(message, config, {
        botId: this.botId(),
        killSwitchOn: false,
        rateLimits: this.rates,
        now: this.now(),
      });
      if (!decision.allow) {
        if (shouldAudit(message, config, decision.reason, this.botId())) {
          this.log.audit(decision.reason, message);
        }
        if (decision.reason === 'user_denied' || decision.reason === 'user_banned') {
          if (shouldAudit(message, config, decision.reason, this.botId())) {
            if (decision.reason === 'user_denied' && message.author) this.noteOutsider(message.author.id);
            await this.alert({
              level: 'P0',
              reason: decision.reason === 'user_banned' ? 'user_banned' : 'outsider_mention',
              detail: decision.reason,
              guildId: message.guildId,
              channelId: message.channelId,
              messageId: message.id,
            });
          }
        }
        if (decision.reason === 'rate_limited_global' || decision.reason === 'rate_limited_daily') {
          await this.tripKillSwitch(decision.reason);
          this.stopAlerted = true;
        }
        return { accepted: false, reason: decision.reason };
      }
      const id = String(message.id);
      if (this.queue.seen(id)) {
        if (shouldAudit(message, config, 'duplicate', this.botId())) this.log.audit('duplicate', message);
        return { accepted: false, reason: 'duplicate' };
      }
      let record = this.buildRecord(message, decision);
      if (record.injectionSuspected) {
        await this.alert({
          level: 'P0',
          reason: 'injection_suspected',
          detail: 'untrusted_discord_content',
          guildId: decision.guildId,
          channelId: decision.channelId,
          messageId: id,
        });
      }
      if (this.hmacKey) record = signRecord(record, this.hmacKey);
      const queued = this.queue.enqueue(record);
      if (!queued.ok) return { accepted: false, reason: 'duplicate' };
      this.rates.commit(message.author.id, decision.channelId, this.now());
      this.saveRates();
      const reactions = this.config.policy.reactions || {};
      if (reactions.enabled) await this.react(message, reactions.ack);
      await this.wake.notify(id);
      return { accepted: true, id };
    } catch (err) {
      this.log.error({ event: 'handle_error', ...errorFields(err) });
      return { accepted: false, reason: 'error' };
    }
  }

  async flushOutbox() {
    if (this.noteKillSwitch()) return { skipped: true };
    if (this.flushing) return { skipped: true, reason: 'in_flight' };
    this.flushing = true;
    try {
      this.queue.quarantineBad('inbox');
      this.queue.quarantineBad('outbox');
      const ranked = [];
      for (const id of this.queue.list('outbox')) {
        try {
          if (this.queue.exists('done', id)) {
            this.queue.remove('outbox', id);
            ranked.push({ id, created: 0, alreadyDone: true });
            continue;
          }
          const inbox = this.queue.read('inbox', id);
          ranked.push({
            id,
            created: inbox && inbox.createdTimestamp ? inbox.createdTimestamp : 0,
          });
        } catch (err) {
          this.queue.quarantine('outbox', `${id}.json`, 'bad_json');
          this.log.warn({ event: 'queue_skip', ...errorFields(err) });
        }
      }
      ranked.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
      const results = [];
      for (const item of ranked) {
        if (item.alreadyDone) {
          results.push({ alreadyDone: true });
          continue;
        }
        try {
          results.push(await this.deliverOne(item.id));
        } catch (err) {
          this.log.warn({ event: 'deliver_skip', messageId: item.id, ...errorFields(err) });
          try { this.queue.quarantine('outbox', `${item.id}.json`, 'bad_json'); } catch (ignore) { /* keep going */ }
          results.push({ dead: true, reason: 'corrupt' });
        }
      }
      return results;
    } finally {
      this.flushing = false;
    }
  }

  rejectReply(id, reason) {
    this.queue.fail(id, { error: reason });
    return this.alert({
      level: 'P0',
      reason: 'reply_rejected',
      detail: reason,
      messageId: id,
    }).then(() => ({ dead: true, reason }));
  }

  async deliverOne(id) {
    if (this.noteKillSwitch()) return { skipped: true };
    if (this.queue.exists('done', id)) {
      this.queue.remove('outbox', id);
      this.queue.removeSending(id);
      return { alreadyDone: true };
    }
    if (this.queue.exists('dead', id)) {
      this.queue.remove('outbox', id);
      this.queue.removeSending(id);
      await this.alert({ level: 'P0', reason: 'reply_rejected', detail: 'already_dead', messageId: id });
      return { dead: true, reason: 'already_dead' };
    }
    let reply = this.queue.read('outbox', id) || this.queue.readSending(id);
    if (!reply) return { missing: true };
    if (reply.final === false) return { waiting: true };
    if (reply.nextAttemptAt && this.now() < Date.parse(reply.nextAttemptAt)) return { waiting: true };
    if (this.queue.exists('outbox', id)) {
      const claimed = this.queue.claimOutbox(id);
      if (!claimed) return { missing: true };
      if (claimed.alreadyDone) return { alreadyDone: true };
      reply = claimed.record;
    }
    if (!reply || typeof reply !== 'object' || typeof reply.text !== 'string'
      || Object.keys(reply).some((key) => !OUTBOX_KEYS.has(key))) {
      return this.rejectReply(id, 'bad_shape');
    }
    if (this.outboxSigRequired() && this.hmacKey && !verifyRecord(reply, this.hmacKey)) {
      return this.rejectReply(id, 'bad_signature');
    }

    const inbox = this.queue.read('inbox', id);
    if (!inbox) {
      this.queue.remove('outbox', id);
      this.queue.removeSending(id);
      await this.alert({ level: 'P0', reason: 'reply_rejected', detail: 'unknown_id', messageId: id });
      return { rejected: true, reason: 'unknown_id' };
    }
    if (this.hmacKey && !verifyRecord(inbox, this.hmacKey)) return this.rejectReply(id, 'bad_signature');
    const replyTo = String(reply.replyTo || '');
    if (replyTo !== String(id)) return this.rejectReply(id, 'reply_id_mismatch');
    if (String(reply.channelId) !== String(inbox.channelId)) return this.rejectReply(id, 'channel_mismatch');
    if (!replyChannelAllowed(this.config, reply.channelId, inbox.parentChannelId)) {
      return this.rejectReply(id, 'channel_denied');
    }

    const capped = stripOutbound(this.redactText(reply.text || ''));
    const chunks = chunkReply(
      capped,
      this.config.policy.maxReplyChars || 1900,
      this.config.policy.maxReplyChunks || 3,
    ).filter((chunk) => chunk.trim().length > 0);
    if (chunks.length === 0) return this.rejectReply(id, 'empty_reply');

    const startAt = reply.sentChunks || 0;
    let message = null;
    try {
      message = await this.resolveMessage(this.client, inbox.channelId, id);
      for (let index = startAt; index < chunks.length; index += 1) {
        await this.replyWithRetry(message, chunks[index]);
        reply.sentChunks = index + 1;
        this.queue.writeSending(id, this.seal(reply));
      }
      await this.swapReaction(message);
      this.queue.complete(id, { chunks: chunks.length });
      return { done: true, chunks: chunks.length };
    } catch (err) {
      const partial = (reply.sentChunks || 0) > 0;
      reply.attempts = (reply.attempts || 0) + 1;
      if (partial && reply.attempts < 3) {
        const wait = Math.min(1000 * (2 ** (reply.attempts - 1)), 8000);
        reply.nextAttemptAt = new Date(this.now() + wait).toISOString();
        this.queue.restoreClaim(id, this.seal(reply));
        this.log.warn({ event: 'send_retry', messageId: id, ...errorFields(err) });
        return { retry: true, attempts: reply.attempts };
      }
      try {
        if (message && typeof message.reply === 'function') {
          await message.reply({ content: FAILURE_NOTICE, allowedMentions: ALLOWED_MENTIONS });
        }
        if (message) await this.react(message, (this.config.policy.reactions || {}).fail);
      } catch (noticeErr) {
        this.log.warn({ event: 'failure_notice_failed', messageId: id, ...errorFields(noticeErr) });
      }
      this.queue.fail(id, { error: 'send_failed' });
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
      this.log.warn({ event: 'react_clear_failed', messageId: message && message.id, ...errorFields(err) });
    }
  }

  async checkTimeouts() {
    if (this.noteKillSwitch()) return;
    const minutes = Number(this.config.policy.commsTimeoutMinutes || 0);
    if (!minutes) return;
    const limit = minutes * 60 * 1000;
    let records = [];
    try {
      records = this.queue.listRecords('inbox');
    } catch (err) {
      this.log.warn({ event: 'timeout_scan_failed', ...errorFields(err) });
      return;
    }
    for (const item of records) {
      try {
        await this.timeoutOne(item, limit);
      } catch (err) {
        this.log.warn({
          event: 'timeout_skip',
          messageId: item && item.discordMessageId,
          ...errorFields(err),
        });
      }
    }
  }

  async timeoutOne(item, limit) {
    if (!item || !item.discordMessageId || item.timeoutNotified) return;
    let outbox = null;
    try { outbox = this.queue.read('outbox', item.discordMessageId); } catch (err) { outbox = null; }
    if (outbox && outbox.final !== false) return;
    const enqueued = Date.parse(item.enqueuedAt);
    if (!Number.isFinite(enqueued) || this.now() - enqueued < limit) return;
    try {
      const message = await this.resolveMessage(this.client, item.channelId, item.discordMessageId);
      await this.replyWithRetry(message, TIMEOUT_NOTICE);
      item.timeoutNotified = true;
      this.queue.overwrite('inbox', item.discordMessageId, this.seal(item));
      await this.requestRewake(item.discordMessageId);
    } catch (err) {
      if (isUnreachable(err)) {
        this.queue.fail(item.discordMessageId, { error: 'unreachable' });
        return;
      }
      this.log.warn({ event: 'timeout_notice_failed', messageId: item.discordMessageId, ...errorFields(err) });
      await this.requestRewake(item.discordMessageId);
    }
  }

  rewakeInbox() {
    let ids = [];
    try { ids = this.queue.list('inbox'); } catch (err) { return; }
    for (const id of ids) {
      if (this.queue.exists('outbox', id)) continue;
      this.requestRewake(id);
    }
  }

  maybeSweep() {
    const ttlDays = this.config.policy.retentionDays || 7;
    const ttl = ttlDays * 24 * 60 * 60 * 1000;
    if (this.lastSweep && this.now() - this.lastSweep < 60 * 60 * 1000) return;
    this.lastSweep = this.now();
    try { this.queue.sweepExpired(this.now(), ttl); } catch (err) {
      this.log.warn({ event: 'sweep_failed', ...errorFields(err) });
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.flushOutbox();
      await this.checkTimeouts();
      this.maybeSweep();
    } catch (err) {
      this.log.error({ event: 'tick_error', ...errorFields(err) });
    } finally {
      this.ticking = false;
    }
  }

  scheduleTick() {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().finally(() => {
        if (!this.stoppedLoop) this.scheduleTick();
      });
    }, this.intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  start() {
    if (this.timer || this.stoppedLoop) return;
    if (this.useLock) {
      this.bridgeLock = new BridgeLock({
        queueDir: this.queue.root,
        token: this.token,
        tokenLockDir: this.tokenLockDir,
      });
      this.bridgeLock.acquire();
    }
    this.queue.sweepTmp();
    this.queue.restoreSending();
    this.rewakeInbox();
    this.scheduleTick();
  }

  stop() {
    this.stoppedLoop = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.wake) this.wake.stop();
    if (this.bridgeLock) this.bridgeLock.release();
  }
}

function secretList(config, env) {
  const names = [
    'DISCORD_TOKEN',
    'DISCORD_TOKEN_DEV',
    'COMMS_WEBHOOK_KEY',
    'COMMS_WEBHOOK_URL',
    'QUEUE_HMAC_KEY',
    'ALERT_WEBHOOK_URL',
    'ALERT_WEBHOOK_KEY',
  ];
  if (config.discord && config.discord.tokenEnv) names.push(config.discord.tokenEnv);
  if (config.wake && config.wake.keyEnv) names.push(config.wake.keyEnv);
  if (config.wake && config.wake.urlEnv) names.push(config.wake.urlEnv);
  const values = [];
  for (const name of names) {
    if (env[name]) values.push(env[name]);
  }
  return values;
}

function attachToClient(client, options = {}) {
  let loaded;
  if (options.config) {
    loaded = { config: clampConfig(options.config), localPath: options.localPath || null };
  } else {
    loaded = loadConfig(options);
  }
  const config = loaded.config;
  const env = options.env || process.env;
  if (config.features.enabled) assertReady(config, { localPath: loaded.localPath, env });
  if (options.adapter) {
    const phiccApp = String(env.PHICC_APPLICATION_ID || '');
    const bridgeApp = String((config.discord && config.discord.applicationId) || '');
    if (!phiccApp || phiccApp === bridgeApp) {
      const error = new Error('ADAPTER_UNVERIFIED');
      error.name = 'BridgeConfigError';
      error.code = 'ADAPTER_UNVERIFIED';
      throw error;
    }
  }

  const queue = options.queue || new FileQueue(expandHome(config.queue.dir));
  const log = options.log || createLogger({
    level: config.logging.level,
    dir: expandHome(config.logging.dir),
    logBodies: config.logging.logBodies,
    hashAuthor: (id) => queue.authorLabel(id),
  });
  if (options.adapter) log.warn({ event: 'adapter_shares_process' });
  if (config.queue && config.queue.requireOutboxSig === false) {
    log.warn({ event: 'outbox_signature_optional' });
  }
  const wake = options.wake || new WakeHandoff({
    url: env[config.wake.urlEnv] || '',
    key: env[config.wake.keyEnv] || '',
    allowedHosts: config.wake.allowedHosts,
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
    hmacKey: options.hmacKey || env[config.wake.hmacEnv || 'QUEUE_HMAC_KEY'] || '',
    alertUrl: options.alertUrl || env.ALERT_WEBHOOK_URL || '',
    alertKey: options.alertKey || env.ALERT_WEBHOOK_KEY || '',
    alertHosts: options.alertHosts || (config.wake && config.wake.allowedHosts) || [],
    alertFetch: options.alertFetch,
    token: options.token || env[config.discord.tokenEnv] || env.DISCORD_TOKEN || '',
    tokenLockDir: options.tokenLockDir,
    lock: options.lock,
    secrets: options.secrets || secretList(config, env),
    alerter: options.alerter,
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
  looksLikeInjection,
  rateLimitDelay,
  shouldAudit,
};
