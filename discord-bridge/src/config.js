'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { clampLimit } = require('./policy');

const SNOWFLAKE = /^\d{17,20}$/;

const ROOT = path.join(__dirname, '..', '..');

function defaultConfig() {
  return {
    botName: 'comms-bot',
    env: 'dev',
    discord: {
      tokenEnv: 'DISCORD_TOKEN_DEV',
      applicationId: 'YOUR_APPLICATION_ID',
      botUserId: '',
      intents: ['Guilds', 'GuildMessages'],
      guildIds: ['YOUR_GUILD_ID'],
      channelIds: ['YOUR_TEST_CHANNEL_ID'],
      allowedUserIds: ['YOUR_USER_ID'],
      allowedRoleIds: [],
      deniedUserIds: [],
      allowThreads: false,
    },
    policy: {
      requireMention: true,
      usersOnly: true,
      ignorePrefixes: ['!!'],
      responseMode: 'reply',
      reactions: { ack: '👀', done: '✅', fail: '❌', enabled: true },
      rateLimits: { perUserPerMin: 3, perChannelPerMin: 10, globalPerHour: 10, globalPerDay: 50 },
      maxReplyChunks: 3,
      maxReplyChars: 1900,
      commsTimeoutMinutes: 10,
      retentionDays: 7,
    },
    queue: { dir: '~/discord-bridge/comms-bot/queue' },
    wake: {
      urlEnv: 'COMMS_WEBHOOK_URL',
      keyEnv: 'COMMS_WEBHOOK_KEY',
      hmacEnv: 'QUEUE_HMAC_KEY',
      allowedHosts: ['YOUR_WEBHOOK_HOST'],
      coalesceQuietMs: 1500,
      coalesceMaxBatch: 5,
      maxPerHour: 10,
    },
    features: {
      enabled: false,
      killSwitchFile: '~/discord-bridge/comms-bot/STOP',
    },
    logging: {
      level: 'info',
      dir: '~/discord-bridge/comms-bot/logs',
      logBodies: false,
    },
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, over) {
  if (over == null) return base;
  if (Array.isArray(over)) return over.slice();
  if (!isObject(over)) return over;
  const out = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(over)) {
    if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
    else out[key] = merge(undefined, value);
  }
  return out;
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function parseBool(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`expected true or false, got ${value}`);
}

function parseCsv(value) {
  if (!String(value).trim()) return [];
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

const ENV_BINDINGS = [
  ['DBR_FEATURES_ENABLED', 'features.enabled', 'bool'],
  ['DBR_FEATURES_KILLSWITCHFILE', 'features.killSwitchFile', 'string'],
  ['DBR_QUEUE_DIR', 'queue.dir', 'string'],
  ['DBR_BOTNAME', 'botName', 'string'],
  ['DBR_DISCORD_TOKENENV', 'discord.tokenEnv', 'string'],
  ['DBR_DISCORD_APPLICATIONID', 'discord.applicationId', 'string'],
  ['DBR_DISCORD_BOTUSERID', 'discord.botUserId', 'string'],
  ['DBR_DISCORD_GUILDIDS', 'discord.guildIds', 'csv'],
  ['DBR_DISCORD_CHANNELIDS', 'discord.channelIds', 'csv'],
  ['DBR_DISCORD_ALLOWEDUSERIDS', 'discord.allowedUserIds', 'csv'],
  ['DBR_DISCORD_ALLOWEDROLEIDS', 'discord.allowedRoleIds', 'csv'],
  ['DBR_DISCORD_DENIEDUSERIDS', 'discord.deniedUserIds', 'csv'],
  ['DBR_DISCORD_ALLOWTHREADS', 'discord.allowThreads', 'bool'],
  ['DBR_POLICY_USERSONLY', 'policy.usersOnly', 'bool'],
  ['DBR_POLICY_MAXREPLYCHUNKS', 'policy.maxReplyChunks', 'int'],
  ['DBR_POLICY_COMMSTIMEOUTMINUTES', 'policy.commsTimeoutMinutes', 'int'],
  ['DBR_WAKE_ALLOWEDHOSTS', 'wake.allowedHosts', 'csv'],
  ['DBR_LOGGING_LEVEL', 'logging.level', 'string'],
  ['DBR_LOGGING_DIR', 'logging.dir', 'string'],
  ['DBR_LOGGING_LOGBODIES', 'logging.logBodies', 'bool'],
  ['DBR_WAKE_QUIETMS', 'wake.coalesceQuietMs', 'int'],
  ['DBR_WAKE_MAXBATCH', 'wake.coalesceMaxBatch', 'int'],
  ['DBR_WAKE_MAXPERHOUR', 'wake.maxPerHour', 'int'],
];

function applyEnv(config, env) {
  const source = env || process.env;
  for (const [name, dotted, kind] of ENV_BINDINGS) {
    if (source[name] == null || source[name] === undefined) continue;
    if (!(name in source)) continue;
    const raw = source[name];
    if (raw == null) continue;
    let value = raw;
    if (kind === 'bool') value = parseBool(String(raw));
    else if (kind === 'csv') value = parseCsv(raw);
    else if (kind === 'int') value = Number(raw);
    else value = String(raw);
    setPath(config, dotted, value);
  }
  return config;
}

function findExisting(candidates) {
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

function loadConfig(options = {}) {
  const root = options.root || ROOT;
  const examplePath = options.examplePath
    || findExisting([
      path.join(root, 'config.example.json'),
      path.join(process.cwd(), 'config.example.json'),
    ]);
  const localPath = options.localPath
    || findExisting([
      path.join(root, 'config.local.json'),
      path.join(process.cwd(), 'config.local.json'),
    ]);

  let config = defaultConfig();
  if (examplePath) config = merge(config, readJson(examplePath));
  if (localPath) config = merge(config, readJson(localPath));
  applyEnv(config, options.env);
  config.queue.dir = expandHome(config.queue.dir);
  config.features.killSwitchFile = expandHome(config.features.killSwitchFile);
  config.logging.dir = expandHome(config.logging.dir);
  clampConfig(config);
  return { config, examplePath, localPath };
}

function clampConfig(config) {
  const limits = config.policy.rateLimits || {};
  limits.perUserPerMin = clampLimit(limits.perUserPerMin, 1, 10, 3);
  limits.perChannelPerMin = clampLimit(limits.perChannelPerMin, 1, 30, 10);
  limits.globalPerHour = clampLimit(limits.globalPerHour, 1, 30, 10);
  limits.globalPerDay = clampLimit(limits.globalPerDay, 1, 100, 50);
  config.policy.rateLimits = limits;
  config.policy.maxReplyChunks = clampLimit(config.policy.maxReplyChunks, 1, 3, 3);
  config.policy.maxReplyChars = clampLimit(config.policy.maxReplyChars, 1, 1900, 1900);
  config.policy.commsTimeoutMinutes = clampLimit(config.policy.commsTimeoutMinutes, 1, 60, 10);
  config.policy.retentionDays = clampLimit(config.policy.retentionDays, 1, 30, 7);
  const wakeCap = clampLimit(config.wake.maxPerHour, 1, limits.globalPerHour, limits.globalPerHour);
  config.wake.maxPerHour = Math.min(wakeCap, limits.globalPerHour);
  if (config.policy.usersOnly == null) config.policy.usersOnly = true;
  if (!Array.isArray(config.discord.deniedUserIds)) config.discord.deniedUserIds = [];
  return config;
}

function refuse(code) {
  const error = new Error(code);
  error.name = 'BridgeConfigError';
  error.code = code;
  return error;
}

function isPlaceholder(value) {
  return typeof value === 'string' && /YOUR_/i.test(value);
}

function assertConfigMode(localPath) {
  if (!localPath || !fs.existsSync(localPath)) return;
  const mode = fs.statSync(localPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error('config.local.json must be chmod 600');
  }
}

function assertSnowflakeList(list, code) {
  for (const id of list) {
    if (!SNOWFLAKE.test(String(id))) throw refuse(code);
  }
}

function assertReady(config, options = {}) {
  if (!config.features || config.features.enabled !== true) return;
  assertConfigMode(options.localPath);
  const discord = config.discord || {};
  const values = [
    discord.applicationId,
    ...(discord.guildIds || []),
    ...(discord.channelIds || []),
    ...(discord.allowedUserIds || []),
    ...(discord.allowedRoleIds || []),
    ...(discord.deniedUserIds || []),
    discord.botUserId,
    ...((config.wake && config.wake.allowedHosts) || []),
  ];
  if (values.some(isPlaceholder)) throw refuse('PLACEHOLDER');
  if (discord.allowDMs === true) throw refuse('DMS_UNSUPPORTED');
  if (!config.policy || config.policy.requireMention === false) throw refuse('MENTION_REQUIRED');
  assertSnowflakeList([discord.applicationId], 'SNOWFLAKE');
  assertSnowflakeList(discord.guildIds || [], 'SNOWFLAKE');
  assertSnowflakeList(discord.channelIds || [], 'SNOWFLAKE');
  assertSnowflakeList(discord.allowedUserIds || [], 'SNOWFLAKE');
  assertSnowflakeList(discord.allowedRoleIds || [], 'SNOWFLAKE');
  assertSnowflakeList(discord.deniedUserIds || [], 'SNOWFLAKE');
  if (discord.botUserId) assertSnowflakeList([discord.botUserId], 'SNOWFLAKE');
  if (!discord.guildIds || discord.guildIds.length === 0) throw refuse('EMPTY_GUILD');
  if (!discord.channelIds || discord.channelIds.length === 0) throw refuse('EMPTY_CHANNEL');
  const users = discord.allowedUserIds || [];
  const roles = discord.allowedRoleIds || [];
  if (users.length === 0 && roles.length === 0) throw refuse('EMPTY_ALLOWLIST');
  if (config.policy.usersOnly !== false && roles.length > 0) throw refuse('USERS_ONLY');
  const guilds = new Set((discord.guildIds || []).map(String));
  if (roles.some((role) => guilds.has(String(role)))) throw refuse('ROLE_IS_GUILD');
  const env = options.env || process.env;
  const url = env[config.wake.urlEnv] || '';
  const key = env[config.wake.keyEnv] || '';
  const hmac = env[config.wake.hmacEnv || 'QUEUE_HMAC_KEY'] || '';
  if (!url || !key) throw refuse('WEBHOOK_REQUIRED');
  if (!hmac || String(hmac).length < 16) throw refuse('HMAC_REQUIRED');
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw refuse('WEBHOOK_HTTPS');
  }
  if (parsed.protocol !== 'https:') throw refuse('WEBHOOK_HTTPS');
  const hosts = config.wake.allowedHosts || [];
  if (!hosts.length || !hosts.includes(parsed.hostname)) throw refuse('WEBHOOK_HOST');
  const alertUrl = env.ALERT_WEBHOOK_URL || '';
  if (alertUrl) {
    try {
      const alert = new URL(alertUrl);
      if (alert.protocol !== 'https:') throw refuse('ALERT_HTTPS');
    } catch (err) {
      if (err.code === 'ALERT_HTTPS') throw err;
      throw refuse('ALERT_HTTPS');
    }
  }
}

module.exports = {
  ROOT,
  ENV_BINDINGS,
  defaultConfig,
  merge,
  expandHome,
  applyEnv,
  loadConfig,
  clampConfig,
  assertReady,
  assertConfigMode,
  isPlaceholder,
  SNOWFLAKE,
};
