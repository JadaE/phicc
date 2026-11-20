'use strict';

const fs = require('fs');

const MAX_SECRET_BYTES = 8192;

function secretFileError() {
  const error = new Error('SECRET_FILE');
  error.name = 'SecretFileError';
  error.code = 'SECRET_FILE';
  return error;
}

function readSecretFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    throw secretFileError();
  }
  if (!buf || buf.length === 0 || buf.length > MAX_SECRET_BYTES) throw secretFileError();
  let text = buf.toString('utf8');
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (!text || text.includes('\n') || text.includes('\u0000')) throw secretFileError();
  return text;
}

/**
 * Resolve one secret. A NAME_FILE value is read into memory and is never
 * written back onto the environment object, so an env dump cannot contain it.
 * A direct NAME value is the box path and is left untouched.
 */
function secretValue(env, name) {
  const source = env || {};
  if (!name) return '';
  const fileVar = `${name}_FILE`;
  if (source[fileVar]) return readSecretFile(String(source[fileVar]));
  if (source[name] == null || source[name] === '') return '';
  return String(source[name]);
}

function resolveSecrets(env, names) {
  const out = {};
  for (const name of names || []) {
    if (!name) continue;
    out[name] = secretValue(env, name);
  }
  return out;
}

module.exports = {
  MAX_SECRET_BYTES,
  readSecretFile,
  secretValue,
  resolveSecrets,
};
