'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const THREAD_TYPES = new Set([
  10,
  11,
  12,
  'GUILD_NEWS_THREAD',
  'GUILD_PUBLIC_THREAD',
  'GUILD_PRIVATE_THREAD',
]);

function clampLimit(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isListed(list, id) {
  if (id == null || id === '' || !Array.isArray(list)) return false;
  const needle = String(id);
  return list.some((item) => String(item) === needle);
}

function prune(stamps, now, windowMs) {
  return (stamps || []).filter((stamp) => now - stamp < windowMs);
}

class RateLimiter {
  constructor(limits) {
    const raw = limits || {};
    this.limits = {
      perUserPerMin: clampLimit(raw.perUserPerMin, 1, 10, 3),
      perChannelPerMin: clampLimit(raw.perChannelPerMin, 1, 30, 10),
      globalPerHour: clampLimit(raw.globalPerHour, 1, 30, 10),
      globalPerDay: clampLimit(raw.globalPerDay, 1, 100, 50),
    };
    this.users = new Map();
    this.channels = new Map();
    this.global = [];
    this.daily = [];
  }

  check(userId, channelId, now) {
    const stamp = now == null ? Date.now() : now;
    const userHits = prune(this.users.get(userId), stamp, MINUTE_MS);
    this.users.set(userId, userHits);
    if (userHits.length >= this.limits.perUserPerMin) {
      return { ok: false, reason: 'rate_limited_user' };
    }
    const channelHits = prune(this.channels.get(channelId), stamp, MINUTE_MS);
    this.channels.set(channelId, channelHits);
    if (channelHits.length >= this.limits.perChannelPerMin) {
      return { ok: false, reason: 'rate_limited_channel' };
    }
    this.global = prune(this.global, stamp, HOUR_MS);
    if (this.global.length >= this.limits.globalPerHour) {
      return { ok: false, reason: 'rate_limited_global' };
    }
    this.daily = prune(this.daily, stamp, DAY_MS);
    if (this.daily.length >= this.limits.globalPerDay) {
      return { ok: false, reason: 'rate_limited_daily' };
    }
    return { ok: true };
  }

  commit(userId, channelId, now) {
    const stamp = now == null ? Date.now() : now;
    const userHits = prune(this.users.get(userId), stamp, MINUTE_MS);
    userHits.push(stamp);
    this.users.set(userId, userHits);
    const channelHits = prune(this.channels.get(channelId), stamp, MINUTE_MS);
    channelHits.push(stamp);
    this.channels.set(channelId, channelHits);
    this.global = prune(this.global, stamp, HOUR_MS);
    this.global.push(stamp);
    this.daily = prune(this.daily, stamp, DAY_MS);
    this.daily.push(stamp);
  }

  checkGlobal(now) {
    const stamp = now == null ? Date.now() : now;
    this.global = prune(this.global, stamp, HOUR_MS);
    if (this.global.length >= this.limits.globalPerHour) {
      return { ok: false, reason: 'rate_limited_global' };
    }
    this.daily = prune(this.daily, stamp, DAY_MS);
    if (this.daily.length >= this.limits.globalPerDay) {
      return { ok: false, reason: 'rate_limited_daily' };
    }
    return { ok: true };
  }

  commitGlobal(now) {
    const stamp = now == null ? Date.now() : now;
    this.global = prune(this.global, stamp, HOUR_MS);
    this.global.push(stamp);
    this.daily = prune(this.daily, stamp, DAY_MS);
    this.daily.push(stamp);
  }

  snapshot() {
    return {
      users: [...this.users.entries()],
      channels: [...this.channels.entries()],
      global: this.global.slice(),
      daily: this.daily.slice(),
    };
  }

  restore(data) {
    if (!data) return;
    this.users = new Map(data.users || []);
    this.channels = new Map(data.channels || []);
    this.global = Array.isArray(data.global) ? data.global.slice() : [];
    this.daily = Array.isArray(data.daily) ? data.daily.slice() : [];
  }
}

function botMentioned(message, botId) {
  if (!botId) return false;
  const users = message.mentions && message.mentions.users;
  if (users && typeof users.has === 'function' && users.has(botId)) return true;
  const content = typeof message.content === 'string' ? message.content : '';
  const pattern = new RegExp(`<@!?${botId}>`);
  return pattern.test(content);
}

function memberHasAllowedRole(message, roleIds) {
  if (!roleIds || roleIds.length === 0) return false;
  const cache = message.member && message.member.roles && message.member.roles.cache;
  if (!cache) return false;
  if (typeof cache.has === 'function') {
    return roleIds.some((id) => cache.has(id));
  }
  if (Array.isArray(cache)) return roleIds.some((id) => cache.includes(id));
  return false;
}

function isRealThread(channel) {
  if (!channel || typeof channel.isThread !== 'function' || channel.isThread() !== true) return false;
  if (channel.type != null && !THREAD_TYPES.has(channel.type)) return false;
  const parent = channel.parent;
  if (parent && (parent.type === 4 || parent.type === 'GUILD_CATEGORY')) return false;
  return true;
}

function channelAllowed(config, message) {
  const channelId = message.channelId || (message.channel && message.channel.id) || null;
  const channel = message.channel || {};
  const parentId = channel.parentId || null;
  if (isListed(config.discord.channelIds, channelId)) {
    return { ok: true, channelId, parentId: null };
  }
  if (config.discord.allowThreads && isRealThread(channel) && isListed(config.discord.channelIds, parentId)) {
    return { ok: true, channelId, parentId };
  }
  return { ok: false, channelId, parentId };
}

function replyChannelAllowed(config, channelId, parentId) {
  if (isListed(config.discord.channelIds, channelId)) return true;
  return Boolean(config.discord.allowThreads && parentId && isListed(config.discord.channelIds, parentId));
}

/**
 * Pure allow/deny decision. Does not record rate-limit usage; the caller
 * commits only after a message is actually queued.
 */
function evaluate(message, config, ctx) {
  const deny = (reason) => ({ allow: false, reason });
  const content = message && typeof message.content === 'string' ? message.content : '';
  const prefixes = (config.policy && config.policy.ignorePrefixes) || [];
  if (prefixes.some((prefix) => prefix && content.startsWith(prefix))) {
    return deny('prefix_command');
  }
  if (!config.features || config.features.enabled !== true) return deny('disabled');
  if (ctx && ctx.killSwitchOn) return deny('kill_switch');
  if (message && message.webhookId) return deny('ignore_webhook');
  if (!message || !message.author || message.author.bot) return deny('ignore_bot');
  const botId = ctx && ctx.botId;
  if (botId && message.author.id === botId) return deny('ignore_self');

  const guildId = message.guildId || (message.guild && message.guild.id) || null;
  if (!guildId) return deny('dm_blocked');
  if (!isListed(config.discord.guildIds, guildId)) return deny('guild_denied');

  const channel = channelAllowed(config, message);
  if (!channel.ok) return deny('channel_denied');

  if (isListed(config.discord.deniedUserIds, message.author.id)) return deny('user_banned');

  const userOk = isListed(config.discord.allowedUserIds, message.author.id);
  const rolesEnabled = config.policy.usersOnly === false;
  const roleOk = rolesEnabled && memberHasAllowedRole(message, config.discord.allowedRoleIds);
  if (!userOk && !roleOk) return deny('user_denied');

  if (!botMentioned(message, botId)) return deny('not_mention');

  const now = ctx && ctx.now != null ? ctx.now : Date.now();
  if (ctx && ctx.rateLimits) {
    const rate = ctx.rateLimits.check(message.author.id, channel.channelId, now);
    if (!rate.ok) return deny(rate.reason);
  }

  return {
    allow: true,
    guildId,
    channelId: channel.channelId,
    parentId: channel.parentId || null,
  };
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  RateLimiter,
  evaluate,
  isListed,
  botMentioned,
  isRealThread,
  channelAllowed,
  replyChannelAllowed,
  clampLimit,
};
