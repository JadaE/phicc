'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { signRecord } = require('./src/sign');

const MAX_PARTS = 8;
const MAX_CONTENT = 2000;
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com']);
const WEBHOOK_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*discord(?:app)?\.com\/api\/webhooks\/\S+/i;

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultReplyEnvPath() {
  if (process.env.REPLY_ENV) return process.env.REPLY_ENV;
  return path.join(os.homedir(), 'discord-bridge', 'comms-bot', 'reply.env');
}

function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function assertReplyEnvMode(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw coded('MISSING_ENV');
  }
  if ((stat.mode & 0o777) !== 0o600) throw coded('ENV_MODE');
}

function loadReplyEnv(file) {
  assertReplyEnvMode(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw coded('MISSING_ENV');
  }
  const env = parseEnvFile(text);
  if (!env.OUTBOX_HMAC_KEY || !env.DISCORD_OUTBOX_WEBHOOK_URL || !env.DISCORD_BOT_USER_ID) {
    throw coded('MISSING_ENV');
  }
  return env;
}

function assertReplyText(text, env) {
  const body = text == null ? '' : String(text);
  const key = env && env.OUTBOX_HMAC_KEY;
  if (typeof key === 'string' && key.length > 0 && body.includes(key)) throw coded('SECRET_TEXT');
  if (WEBHOOK_URL_RE.test(body)) throw coded('SECRET_TEXT');
  const url = env && env.DISCORD_OUTBOX_WEBHOOK_URL;
  if (typeof url === 'string' && url.length > 0 && body.includes(url)) throw coded('SECRET_TEXT');
}

function assertWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw coded('WEBHOOK_URL');
  }
  if (parsed.protocol !== 'https:') throw coded('WEBHOOK_HTTPS');
  const host = parsed.hostname.toLowerCase();
  const allowed = DISCORD_HOSTS.has(host)
    || host.endsWith('.discord.com')
    || host.endsWith('.discordapp.com');
  if (!allowed) throw coded('WEBHOOK_HOST');
  return parsed;
}

function encodeSigned(record, key) {
  const signed = signRecord(record, key);
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
}

function contentFor(record, key, botId) {
  return `<@${botId}> DBR1 ${encodeSigned(record, key)}`;
}

function buildRecord(meta, body) {
  return {
    v: 1,
    rid: String(meta.rid),
    ch: String(meta.ch),
    part: meta.part,
    parts: meta.parts,
    nonce: meta.nonce,
    ts: meta.ts,
    body,
  };
}

/**
 * Split `text` so each `<@bot> DBR1 <b64>` part is at most 2000 characters
 * and there are at most 8 parts. Returns the unsigned part records.
 */
function splitReply(text, meta) {
  const clean = text == null ? '' : String(text);
  if (!clean.trim()) throw coded('EMPTY');
  const botId = String(meta.botId);
  const key = meta.key;
  const ts = meta.ts;
  const rid = String(meta.rid);
  const ch = String(meta.ch);
  const nonces = meta.nonces || (() => crypto.randomBytes(16).toString('hex'));

  function measure(body, part, parts) {
    const nonce = 'a'.repeat(32);
    return contentFor(buildRecord({
      rid, ch, part, parts, nonce, ts,
    }, body), key, botId).length;
  }

  let parts = 1;
  let chunks = null;
  while (parts <= MAX_PARTS) {
    const budget = findBudget(clean.length, (size) => measure('a'.repeat(size), 1, parts) <= MAX_CONTENT);
    if (budget < 1) {
      parts += 1;
      continue;
    }
    const trial = sliceText(clean, budget);
    if (trial.length > MAX_PARTS) {
      parts += 1;
      continue;
    }
    const actualParts = trial.length;
    let ok = true;
    for (let index = 0; index < trial.length; index += 1) {
      if (measure(trial[index], index + 1, actualParts) > MAX_CONTENT) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      parts += 1;
      continue;
    }
    chunks = trial;
    break;
  }
  if (!chunks) throw coded('TOO_MANY_PARTS');
  if (chunks.length > MAX_PARTS) throw coded('TOO_MANY_PARTS');

  const records = chunks.map((body, index) => buildRecord({
    rid,
    ch,
    part: index + 1,
    parts: chunks.length,
    nonce: nonces(),
    ts,
  }, body));
  for (const record of records) {
    if (contentFor(record, key, botId).length > MAX_CONTENT) throw coded('TOO_MANY_PARTS');
    if (!/^[0-9a-f]{32}$/.test(record.nonce)) throw coded('NONCE');
  }
  return records;
}

function findBudget(length, fits) {
  let lo = 1;
  let hi = length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function sliceText(text, budget) {
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, budget));
    rest = rest.slice(budget);
  }
  return chunks;
}

function retryAfterMs(response) {
  if (!response) return 1000;
  if (Number.isFinite(response.retryAfterMs) && response.retryAfterMs > 0) {
    return Math.min(response.retryAfterMs, 15 * 60 * 1000);
  }
  const header = response.headers && (response.headers['retry-after'] || response.headers['Retry-After']);
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 15 * 60 * 1000);
  return 1000;
}

function discordTransport({ url, body, timeoutMs = 10000 }) {
  const parsed = assertWebhookUrl(url);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      method: 'POST',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers || {},
          retryAfterMs: retryAfterMs({ headers: res.headers }),
          bodyText: Buffer.concat(chunks).toString('utf8').slice(0, 200),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(coded('TIMEOUT'));
    });
    req.on('error', () => reject(coded('HTTP')));
    req.write(payload);
    req.end();
  });
}

async function postOne(options, content) {
  const transport = options.transport || discordTransport;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }));
  const maxAttempts = options.maxAttempts || 5;
  const body = {
    content,
    allowed_mentions: { parse: [], users: [String(options.botId)] },
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await transport({ url: options.url, body });
    const status = response && response.status;
    if (status === 429) {
      if (attempt === maxAttempts) throw coded('RATE_LIMIT');
      await sleep(retryAfterMs(response));
      continue;
    }
    if (status >= 200 && status < 300) return { status };
    throw coded('HTTP');
  }
  throw coded('HTTP');
}

async function postReply(options) {
  const env = options.env || loadReplyEnv(options.envFile || defaultReplyEnvPath());
  const key = env.OUTBOX_HMAC_KEY;
  const url = env.DISCORD_OUTBOX_WEBHOOK_URL;
  const botId = String(env.DISCORD_BOT_USER_ID);
  if (!/^\d{1,25}$/.test(String(options.msgId || ''))) throw coded('MSG_ID');
  if (!/^\d{1,25}$/.test(String(options.channelId || ''))) throw coded('CHANNEL_ID');
  if (!/^\d{17,20}$/.test(botId)) throw coded('BOT_ID');
  assertWebhookUrl(url);
  let text = options.text;
  if (text == null) {
    try {
      text = fs.readFileSync(options.textFile, 'utf8');
    } catch (err) {
      throw coded('TEXT_FILE');
    }
  }
  assertReplyText(text, env);
  const records = splitReply(text, {
    botId,
    key,
    rid: String(options.msgId),
    ch: String(options.channelId),
    ts: options.ts == null ? Date.now() : options.ts,
    nonces: options.nonces,
  });
  const posted = [];
  for (const record of records) {
    const content = contentFor(record, key, botId);
    await postOne({
      url,
      botId,
      transport: options.transport,
      sleep: options.sleep,
      maxAttempts: options.maxAttempts,
    }, content);
    posted.push({ part: record.part, parts: record.parts, nonce: record.nonce });
  }
  return { ok: true, parts: posted.length, posted };
}

function safeError(err) {
  const code = err && err.code ? String(err.code) : 'FAILED';
  if (!/^[A-Z0-9_]{1,40}$/.test(code)) return 'FAILED';
  return code;
}

async function main(argv, options = {}) {
  const args = (argv || process.argv).slice(2);
  const log = options.log || ((line) => console.log(line));
  const errLog = options.errLog || ((line) => console.error(line));
  if (args[0] === '--help' || args.length < 3) {
    log('usage: post-reply <msgId> <channelId> <textfile>');
    return args[0] === '--help' ? 0 : 2;
  }
  try {
    const result = await postReply({
      msgId: args[0],
      channelId: args[1],
      textFile: args[2],
      envFile: options.envFile,
      env: options.env,
      transport: options.transport,
      sleep: options.sleep,
      ts: options.ts,
      nonces: options.nonces,
      maxAttempts: options.maxAttempts,
    });
    log(JSON.stringify({ event: 'posted', parts: result.parts }));
    return 0;
  } catch (err) {
    errLog(JSON.stringify({ event: 'post_reply_failed', reason: safeError(err) }));
    return 1;
  }
}

module.exports = {
  MAX_PARTS,
  MAX_CONTENT,
  parseEnvFile,
  loadReplyEnv,
  assertReplyEnvMode,
  assertReplyText,
  assertWebhookUrl,
  encodeSigned,
  contentFor,
  splitReply,
  retryAfterMs,
  postReply,
  postOne,
  main,
  safeError,
  defaultReplyEnvPath,
};
