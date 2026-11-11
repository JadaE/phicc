'use strict';

const crypto = require('crypto');

// Discord bot tokens: three base64-ish segments. Built so this file does not contain one.
const TOKEN_RE = new RegExp(
  '\\b[A-Za-z0-9_-]{24,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}\\b',
  'g',
);
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;

const SECRET_KEYS = new Set([
  'key',
  'token',
  'authorization',
  'webhookkey',
  'password',
  'secret',
  'comms_webhook_key',
  'discord_token',
]);

function redact(value) {
  return String(value == null ? '' : value)
    .replace(TOKEN_RE, '[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]');
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function redactValue(value, depth) {
  if (value == null) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[object]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEYS.has(String(key).toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactValue(inner, depth + 1);
  }
  return out;
}

module.exports = {
  TOKEN_RE,
  redact,
  redactValue,
  hashId,
};
