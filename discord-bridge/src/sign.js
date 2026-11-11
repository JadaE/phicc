'use strict';

const crypto = require('crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'sig') continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function signatureFor(record, key) {
  return crypto.createHmac('sha256', String(key)).update(JSON.stringify(canonicalize(record))).digest('hex');
}

function signRecord(record, key) {
  if (!key) return { ...record };
  const body = { ...record };
  delete body.sig;
  return { ...body, sig: signatureFor(body, key) };
}

function verifyRecord(record, key) {
  if (!key || !record || typeof record.sig !== 'string') return false;
  const expected = signatureFor(record, key);
  const left = Buffer.from(record.sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { canonicalize, signRecord, verifyRecord };
