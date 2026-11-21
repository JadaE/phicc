'use strict';

const fs = require('fs');
const path = require('path');
const { verifyRecord, signRecord } = require('./sign');
const { replyChannelAllowed, isListed } = require('./policy');

const { errorFields } = require('./log');

const MAX_CONTENT_CHARS = 2000;
const MAX_DECODED_BYTES = 8192;
const MAX_PARTS = 8;
const MAX_SKEW_MS = 30 * 60 * 1000;
const PART_WINDOW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 48 * 60 * 60 * 1000;
const SEEN_TTL_MS = NONCE_TTL_MS;
const SEEN_SWEEP_LIMIT = 64;
const SEEN_SWEEP_EVERY_MS = 60 * 1000;
const ALERT_WINDOW_MS = 10 * 60 * 1000;
const ROTATION_WINDOW_MS = 10 * 60 * 1000;
const ALLOWED_KEYS = ['v', 'rid', 'ch', 'part', 'parts', 'nonce', 'ts', 'body', 'sig'];

function envelopeConfigured(config) {
  const envelope = config && config.envelope;
  if (!envelope || envelope.enabled !== true) return false;
  if (!envelope.outboxChannelId) return false;
  if (!Array.isArray(envelope.webhookIds) || envelope.webhookIds.length === 0) return false;
  return true;
}

function selectKeys(options) {
  const now = options.now == null ? Date.now() : options.now;
  const windowMs = options.windowMs == null ? ROTATION_WINDOW_MS : options.windowMs;
  const keys = [];
  if (options.current) keys.push(String(options.current));
  const since = Number(options.previousSince);
  const previous = options.previous ? String(options.previous) : '';
  if (previous && Number.isFinite(since) && since <= now && now - since <= windowMs) {
    keys.push(previous);
  }
  return keys;
}

function verifyEnvelope(record, keys) {
  const list = (keys || []).filter((key) => typeof key === 'string' && key.length > 0);
  if (list.length === 0 || !record) return false;
  let ok = 0;
  for (const key of list) {
    ok |= verifyRecord(record, key) ? 1 : 0;
  }
  return ok === 1;
}

function decodeBase64Url(input) {
  if (typeof input !== 'string' || !input || !/^[A-Za-z0-9_-]+$/.test(input)) return null;
  let buf;
  try {
    buf = Buffer.from(input, 'base64url');
  } catch (err) {
    return null;
  }
  if (!buf || buf.length === 0) return null;
  if (buf.toString('base64url') !== input) return null;
  return buf;
}

function parseEnvelopeJson(buf, maxBytes) {
  const limit = maxBytes == null ? MAX_DECODED_BYTES : maxBytes;
  if (!buf || buf.length > limit) return { ok: false, reason: 'size' };
  let value;
  try {
    const text = buf.toString('utf8');
    if (text.trim() !== text) return { ok: false, reason: 'decode' };
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'decode' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'decode' };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_KEYS.includes(key))) return { ok: false, reason: 'decode' };
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: false, reason: 'decode' };
  }
  if (value.v !== 1) return { ok: false, reason: 'decode' };
  if (typeof value.rid !== 'string' || !/^\d{1,25}$/.test(value.rid)) return { ok: false, reason: 'decode' };
  if (typeof value.ch !== 'string' || !/^\d{1,25}$/.test(value.ch)) return { ok: false, reason: 'decode' };
  if (!Number.isInteger(value.part) || !Number.isInteger(value.parts)) return { ok: false, reason: 'decode' };
  if (value.parts < 1 || value.parts > MAX_PARTS || value.part < 1 || value.part > value.parts) {
    return { ok: false, reason: 'decode' };
  }
  if (typeof value.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(value.nonce)) {
    return { ok: false, reason: 'decode' };
  }
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts) || !Number.isInteger(value.ts)) {
    return { ok: false, reason: 'decode' };
  }
  if (typeof value.body !== 'string') return { ok: false, reason: 'decode' };
  if (typeof value.sig !== 'string' || !/^[0-9a-f]{64}$/.test(value.sig)) {
    return { ok: false, reason: 'decode' };
  }
  return { ok: true, record: value };
}

function extractPayload(content, botId) {
  const text = typeof content === 'string' ? content : '';
  if (!botId) return null;
  const match = text.match(new RegExp(`^<@!?${botId}>\\s+DBR1\\s+([A-Za-z0-9_-]+)\\s*$`));
  return match ? match[1] : null;
}

function looksLikeEnvelope(content) {
  return typeof content === 'string' && /(?:^|\s)DBR1(?:\s|$)/.test(content);
}

class SeenIds {
  constructor(dir, ttlMs) {
    this.dir = dir;
    this.ttlMs = ttlMs == null ? SEEN_TTL_MS : ttlMs;
    this.memory = new Map();
    this.cursor = 0;
  }

  pathFor(id) {
    const key = String(id || '');
    if (!/^\d{1,25}$/.test(key)) return null;
    return path.join(this.dir, key);
  }

  readStamp(file) {
    try {
      const seen = Number(fs.readFileSync(file, 'utf8'));
      return Number.isFinite(seen) ? seen : null;
    } catch (err) {
      return null;
    }
  }

  fresh(seen, now) {
    return Number.isFinite(seen) && seen >= 1e12 && now - seen <= this.ttlMs;
  }

  has(id, now) {
    const key = String(id || '');
    if (!key) return false;
    const stamp = now == null ? Date.now() : now;
    if (this.memory.has(key)) {
      const seen = this.memory.get(key);
      if (this.fresh(seen, stamp)) return true;
      this.memory.delete(key);
    }
    const file = this.pathFor(key);
    if (!file || !fs.existsSync(file)) return false;
    const seen = this.readStamp(file);
    if (seen == null) return true;
    if (seen < 1e12) return true;
    if (!this.fresh(seen, stamp)) return false;
    this.memory.set(key, seen);
    return true;
  }

  add(id, now) {
    const file = this.pathFor(id);
    if (!file) return;
    const stamp = now == null ? Date.now() : now;
    this.memory.set(String(id), stamp);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch (err) { /* best effort */ }
    fs.writeFileSync(file, `${stamp}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (err) { /* best effort */ }
  }

  /**
   * Drop ids older than the TTL. Examines at most `limit` directory entries
   * so a large store cannot stall the tick. A legacy file with no timestamp
   * is refreshed to `now` and then ages out on a later sweep.
   */
  sweep(now, limit) {
    const stamp = now == null ? Date.now() : now;
    const cap = Number.isInteger(limit) && limit > 0 ? limit : SEEN_SWEEP_LIMIT;
    let memoryExamined = 0;
    for (const [id, seenAt] of this.memory) {
      if (memoryExamined >= cap) break;
      memoryExamined += 1;
      if (!this.fresh(seenAt, stamp)) this.memory.delete(id);
    }
    if (!this.dir || !fs.existsSync(this.dir)) return 0;
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => /^\d{1,25}$/.test(name));
    } catch (err) {
      return 0;
    }
    if (names.length === 0) {
      this.cursor = 0;
      return 0;
    }
    let index = this.cursor % names.length;
    let removed = 0;
    let examined = 0;
    const budget = Math.min(cap, names.length);
    while (examined < budget) {
      const name = names[index];
      index = (index + 1) % names.length;
      examined += 1;
      const file = path.join(this.dir, name);
      const seen = this.readStamp(file);
      if (seen != null && seen < 1e12) {
        try { fs.writeFileSync(file, `${stamp}\n`, { mode: 0o600 }); } catch (err) { /* ignore */ }
        continue;
      }
      if (seen == null || !this.fresh(seen, stamp)) {
        try { fs.unlinkSync(file); removed += 1; } catch (err) { /* ignore */ }
        this.memory.delete(name);
      }
    }
    this.cursor = names.length === examined ? 0 : index;
    return removed;
  }
}

class NonceStore {
  constructor(dir, ttlMs) {
    this.dir = dir;
    this.ttlMs = ttlMs == null ? NONCE_TTL_MS : ttlMs;
  }

  pathFor(nonce) {
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('invalid nonce');
    return path.join(this.dir, nonce);
  }

  sweep(now) {
    if (!this.dir || !fs.existsSync(this.dir)) return;
    const stamp = now == null ? Date.now() : now;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^[0-9a-f]{32}$/.test(name)) continue;
      const file = path.join(this.dir, name);
      let seen = NaN;
      try { seen = Number(fs.readFileSync(file, 'utf8')); } catch (err) { seen = NaN; }
      if (!Number.isFinite(seen) || stamp - seen > this.ttlMs) {
        try { fs.unlinkSync(file); } catch (err) { /* ignore */ }
      }
    }
  }

  /**
   * Returns true the first time `nonce` is seen inside the TTL. A repeat is a replay.
   */
  remember(nonce, now) {
    const stamp = now == null ? Date.now() : now;
    this.sweep(stamp);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch (err) { /* best effort */ }
    const dest = this.pathFor(nonce);
    if (fs.existsSync(dest)) {
      let seen = NaN;
      try { seen = Number(fs.readFileSync(dest, 'utf8')); } catch (err) { seen = NaN; }
      if (Number.isFinite(seen) && stamp - seen <= this.ttlMs) return false;
      try { fs.unlinkSync(dest); } catch (err) { return false; }
    }
    const tmp = path.join(this.dir, `.${nonce}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(tmp, String(stamp), { mode: 0o600 });
    try {
      fs.linkSync(tmp, dest);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (unlinkErr) { /* ignore */ }
      return false;
    }
    try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    try { fs.chmodSync(dest, 0o600); } catch (err) { /* best effort */ }
    return true;
  }

  seen(nonce, now) {
    const dest = this.pathFor(nonce);
    if (!fs.existsSync(dest)) return false;
    const stamp = now == null ? Date.now() : now;
    const seen = Number(fs.readFileSync(dest, 'utf8'));
    return Number.isFinite(seen) && stamp - seen <= this.ttlMs;
  }
}

class PartStore {
  constructor(dir) {
    this.dir = dir;
    this.messages = new Map();
  }

  fileFor(rid) {
    if (!/^\d{1,25}$/.test(String(rid))) throw new Error('invalid message id');
    return path.join(this.dir, `${rid}.json`);
  }

  load(rid) {
    const file = this.fileFor(rid);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return null;
    }
  }

  write(rid, record) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(rid);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (err) { /* best effort */ }
  }

  rememberMessage(rid, part, message) {
    const key = String(rid);
    if (!this.messages.has(key)) this.messages.set(key, new Map());
    if (message) this.messages.get(key).set(Number(part), message);
  }

  messagesFor(rid) {
    const map = this.messages.get(String(rid));
    if (!map) return [];
    return [...map.values()];
  }

  hasMessage(id) {
    const key = String(id || '');
    if (!key) return false;
    for (const map of this.messages.values()) {
      for (const message of map.values()) {
        if (message && String(message.id) === key) return true;
      }
    }
    if (!this.dir || !fs.existsSync(this.dir)) return false;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^\d{1,25}\.json$/.test(name)) continue;
      const record = this.load(name.slice(0, -5));
      if (record && Array.isArray(record.messageIds) && record.messageIds.map(String).includes(key)) {
        return true;
      }
    }
    return false;
  }

  discard(rid) {
    const key = String(rid || '');
    const record = key ? this.load(key) : null;
    const ids = record && Array.isArray(record.messageIds) ? record.messageIds.slice() : [];
    this.messages.delete(key);
    if (key) {
      const file = this.fileFor(key);
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (err) { /* ignore */ }
      }
    }
    return ids;
  }

  /**
   * Record one authenticated part. `expired` means the 5 minute arrival window
   * has already closed. `complete` means every part is present.
   */
  add(rec, message, now, windowMs) {
    const stamp = now == null ? Date.now() : now;
    const limit = windowMs == null ? PART_WINDOW_MS : windowMs;
    const rid = String(rec.rid);
    let current = this.load(rid);
    if (current && stamp - Number(current.startedAt) > limit) {
      return { expired: true, record: current };
    }
    if (!current) {
      current = {
        rid,
        ch: String(rec.ch),
        partsExpected: rec.parts,
        startedAt: stamp,
        bodies: {},
        messageIds: [],
      };
    }
    if (current.partsExpected !== rec.parts || String(current.ch) !== String(rec.ch)) {
      return { conflict: true, record: current };
    }
    const slot = String(rec.part);
    if (Object.prototype.hasOwnProperty.call(current.bodies, slot) && current.bodies[slot] !== rec.body) {
      return { conflict: true, record: current };
    }
    current.bodies[slot] = rec.body;
    const messageId = message && message.id != null ? String(message.id) : '';
    if (messageId && !current.messageIds.includes(messageId)) current.messageIds.push(messageId);
    this.rememberMessage(rid, rec.part, message);
    const ready = [];
    for (let part = 1; part <= current.partsExpected; part += 1) {
      if (!Object.prototype.hasOwnProperty.call(current.bodies, String(part))) {
        this.write(rid, current);
        return { waiting: true, record: current };
      }
      ready.push(current.bodies[String(part)]);
    }
    if (stamp - Number(current.startedAt) > limit) return { expired: true, record: current };
    return { complete: true, text: ready.join(''), record: current };
  }

  expired(now, windowMs) {
    const stamp = now == null ? Date.now() : now;
    const limit = windowMs == null ? PART_WINDOW_MS : windowMs;
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    const ids = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^\d{1,25}\.json$/.test(name)) continue;
      const rid = name.slice(0, -5);
      const record = this.load(rid);
      if (!record) continue;
      const have = record.bodies ? Object.keys(record.bodies).length : 0;
      if (have >= Number(record.partsExpected)) continue;
      if (stamp - Number(record.startedAt) > limit) ids.push(rid);
    }
    return ids;
  }
}

async function deleteMessage(message) {
  if (!message || typeof message.delete !== 'function') return false;
  try {
    await message.delete();
    return true;
  } catch (err) {
    return false;
  }
}

class EnvelopeIngress {
  constructor(options) {
    this.bridge = options.bridge;
    this.queue = options.queue;
    this.config = options.config;
    this.now = options.now || (() => Date.now());
    this.alert = options.alert || (async () => {});
    this.log = options.log || { warn() {}, error() {} };
    this.alertWindowMs = options.alertWindowMs == null ? ALERT_WINDOW_MS : options.alertWindowMs;
    this.dropLogWindowMs = options.dropLogWindowMs == null ? ALERT_WINDOW_MS : options.dropLogWindowMs;
    this.seenSweepEveryMs = options.seenSweepEveryMs == null ? SEEN_SWEEP_EVERY_MS : options.seenSweepEveryMs;
    this.seenSweepLimit = options.seenSweepLimit == null ? SEEN_SWEEP_LIMIT : options.seenSweepLimit;
    this.alertState = null;
    this.dropLog = null;
    this.lastSeenSweep = null;
    this.outboxChannelId = String(options.outboxChannelId || '');
    this.webhookIds = options.webhookIds || [];
    this.botId = String(options.botId || '');
    this.currentKey = options.currentKey || '';
    this.previousKey = options.previousKey || '';
    this.previousSince = options.previousSince == null ? null : Number(options.previousSince);
    this.windowMs = options.windowMs == null ? ROTATION_WINDOW_MS : options.windowMs;
    this.maxSkewMs = options.maxSkewMs == null ? MAX_SKEW_MS : options.maxSkewMs;
    this.partWindowMs = options.partWindowMs == null ? PART_WINDOW_MS : options.partWindowMs;
    this.maxContentChars = options.maxContentChars == null ? MAX_CONTENT_CHARS : options.maxContentChars;
    this.maxDecodedBytes = options.maxDecodedBytes == null ? MAX_DECODED_BYTES : options.maxDecodedBytes;
    this.resolveMessage = options.resolveMessage || (this.bridge && this.bridge.resolveMessage);
    const stateDir = options.stateDir;
    this.nonces = options.nonces || new NonceStore(path.join(stateDir, 'nonces'), options.nonceTtlMs);
    this.parts = options.parts || new PartStore(path.join(stateDir, 'parts'));
    this.seen = options.seen || new SeenIds(
      path.join(stateDir, 'envelope-seen'),
      options.seenTtlMs,
    );
    this.enabled = true;
  }

  keys() {
    return selectKeys({
      current: this.currentKey,
      previous: this.previousKey,
      previousSince: this.previousSince,
      now: this.now(),
      windowMs: this.windowMs,
    });
  }

  async deleteTracked(rid, message) {
    const held = rid ? this.parts.messagesFor(rid) : [];
    const ids = rid ? this.parts.discard(rid) : [];
    const seen = new Set();
    const pending = [];
    const add = (item) => {
      if (!item || seen.has(item)) return;
      seen.add(item);
      pending.push(item);
    };
    for (const item of held) add(item);
    add(message);
    const deleted = new Set();
    for (const item of pending) {
      const ok = await deleteMessage(item);
      if (ok && item.id != null) deleted.add(String(item.id));
    }
    if (this.resolveMessage && this.bridge) {
      for (const id of ids) {
        if (deleted.has(String(id))) continue;
        try {
          const resolved = await this.resolveMessage(this.bridge.client, this.outboxChannelId, id);
          await deleteMessage(resolved);
        } catch (err) { /* already gone */ }
      }
    }
  }

  alreadySeen(message) {
    const id = message && message.id;
    if (id == null) return false;
    return this.seen.has(id, this.now()) || this.parts.hasMessage(id);
  }

  logStore(err) {
    try {
      if (this.log && typeof this.log.error === 'function') {
        this.log.error({ event: 'envelope_store', ...errorFields(err) });
      }
    } catch (logErr) { /* logging must not become the failure */ }
  }

  warnLimited(reason, message) {
    try {
      const now = this.now();
      const state = this.dropLog;
      if (state == null || now - state.start >= this.dropLogWindowMs) {
        const suppressed = state ? state.suppressed : 0;
        this.dropLog = { start: now, suppressed: 0 };
        if (this.log && typeof this.log.warn === 'function') {
          this.log.warn({
            event: 'envelope_dropped',
            reason: /^[a-z_]{1,40}$/.test(reason || '') ? reason : 'malformed',
            suppressed,
            messageId: message && message.id != null ? String(message.id) : '',
            channelId: message && message.channelId != null ? String(message.channelId) : '',
          });
        }
        return;
      }
      state.suppressed += 1;
    } catch (err) { /* a log failure must not dead-letter the reply */ }
  }

  async coalesceAlert(entry) {
    const now = this.now();
    const state = this.alertState;
    if (state != null && now - state.start < this.alertWindowMs) {
      state.suppressed += 1;
      return false;
    }
    const count = (state ? state.suppressed : 0) + 1;
    this.alertState = { start: now, suppressed: 0 };
    await this.alert({ ...entry, count });
    return true;
  }

  async dropUnauthenticated(message, reason) {
    await deleteMessage(message);
    this.warnLimited(reason, message);
    return { rejected: true, reason };
  }

  /**
   * A copied or late part with its own Discord message id. Delete that message
   * only. Leave any in-progress parts and the pending inbox item alone.
   */
  async dropCopy(message, reason, rid) {
    await deleteMessage(message);
    let done = false;
    try {
      done = Boolean(rid && this.queue && this.queue.exists('done', String(rid)));
    } catch (err) {
      done = false;
    }
    if (done) return { ignored: true, reason: 'already_done' };
    this.warnLimited(reason, message);
    return { dropped: true, reason };
  }

  async reject(message, reason, authenticated, rid) {
    if (!authenticated) return this.dropUnauthenticated(message, reason);
    if (rid && this.queue && this.queue.exists('done', String(rid))) {
      await deleteMessage(message);
      return { ignored: true, reason: 'already_done' };
    }
    await this.deleteTracked(rid, message);
    const deadId = rid ? String(rid) : '';
    if (deadId && /^\d{1,25}$/.test(deadId) && this.queue) {
      try {
        this.queue.fail(deadId, { error: reason, envelope: true });
      } catch (err) { /* still alert */ }
    }
    await this.coalesceAlert({
      level: 'P0',
      reason: 'envelope_rejected',
      detail: reason,
      messageId: (message && message.id) || rid || '',
      channelId: (message && message.channelId) || this.outboxChannelId,
    });
    return { rejected: true, reason };
  }

  async pipeline(text, rec) {
    const rid = String(rec.rid);
    let reply = {
      replyTo: rid,
      channelId: String(rec.ch),
      text,
      final: true,
    };
    const hmacKey = this.bridge && this.bridge.hmacKey;
    if (hmacKey) reply = signRecord(reply, hmacKey);
    this.queue.overwrite('outbox', rid, reply);
    const result = await this.bridge.deliverOne(rid);
    await this.deleteTracked(rid, null);
    if (result && result.done) return { done: true, rid, chunks: result.chunks };
    if (!(result && (result.dead || result.rejected))) {
      return this.reject(null, 'pipeline', true, rid);
    }
    await this.coalesceAlert({
      level: 'P0',
      reason: 'envelope_rejected',
      detail: (result && result.reason) || 'pipeline',
      messageId: rid,
      channelId: rec.ch,
    });
    return { rejected: true, reason: (result && result.reason) || 'pipeline', result };
  }

  async handle(message) {
    const stage = { authenticated: false, rid: null };
    try {
      return await this.dispatch(message, stage);
    } catch (err) {
      try {
        return await this.onStoreError(message, stage, err);
      } catch (inner) {
        this.logStore(inner);
        return { rejected: true, reason: 'store' };
      }
    }
  }

  async onStoreError(message, stage, err) {
    this.logStore(err);
    if (stage && stage.authenticated) {
      return this.reject(message, 'store', true, stage.rid);
    }
    await deleteMessage(message);
    return { rejected: true, reason: 'store' };
  }

  async dispatch(message, stage) {
    if (!this.enabled) return { ignored: true, reason: 'envelope_off' };
    if (this.bridge && typeof this.bridge.disabled === 'function' && this.bridge.disabled()) {
      return { ignored: true, reason: 'disabled' };
    }
    const content = message && typeof message.content === 'string' ? message.content : '';
    const inOutbox = message && String(message.channelId) === this.outboxChannelId;
    if (!inOutbox) return { ignored: true, reason: 'not_envelope' };
    const shaped = looksLikeEnvelope(content);
    if (!shaped && !(message && message.webhookId)) return { ignored: true, reason: 'not_envelope' };
    if (this.alreadySeen(message)) return { ignored: true, reason: 'duplicate' };

    if (!isListed(this.webhookIds, message.webhookId)) {
      return this.reject(message, 'bad_webhook', false, null);
    }

    if (content.length > this.maxContentChars) return this.reject(message, 'size', false, null);
    const payload = extractPayload(content, this.botId);
    if (!payload) return this.reject(message, 'decode', false, null);
    const decoded = decodeBase64Url(payload);
    if (!decoded) return this.reject(message, 'decode', false, null);
    if (decoded.length > this.maxDecodedBytes) return this.reject(message, 'size', false, null);
    const parsed = parseEnvelopeJson(decoded, this.maxDecodedBytes);
    if (!parsed.ok) return this.reject(message, parsed.reason, false, null);

    if (!verifyEnvelope(parsed.record, this.keys())) {
      return this.reject(message, 'hmac', false, null);
    }
    const rec = parsed.record;
    if (stage) {
      stage.authenticated = true;
      stage.rid = String(rec.rid);
    }
    if (message && message.id != null) this.seen.add(message.id, this.now());
    if (Math.abs(this.now() - rec.ts) > this.maxSkewMs) {
      return this.dropCopy(message, 'stale', rec.rid);
    }
    if (!this.nonces.remember(rec.nonce, this.now())) {
      return this.dropCopy(message, 'replay', rec.rid);
    }

    let inbox = null;
    try { inbox = this.queue.read('inbox', rec.rid); } catch (err) { inbox = null; }
    const pending = Boolean(inbox)
      && !this.queue.exists('done', rec.rid)
      && !this.queue.exists('dead', rec.rid);
    if (!pending) return this.reject(message, 'not_pending', true, rec.rid);
    if (String(rec.ch) !== String(inbox.channelId)) {
      return this.reject(message, 'channel_mismatch', true, rec.rid);
    }
    if (!replyChannelAllowed(this.config, rec.ch, inbox.parentChannelId)) {
      return this.reject(message, 'channel_denied', true, rec.rid);
    }

    const assembled = this.parts.add(rec, message, this.now(), this.partWindowMs);
    if (assembled.expired) return this.reject(message, 'parts_timeout', true, rec.rid);
    if (assembled.conflict) return this.reject(message, 'part_conflict', true, rec.rid);
    if (!assembled.complete) return { waiting: true, rid: rec.rid };
    return this.pipeline(assembled.text, rec);
  }

  sweepSeen() {
    if (!this.seen || typeof this.seen.sweep !== 'function') return 0;
    const now = this.now();
    if (this.lastSeenSweep != null && now - this.lastSeenSweep < this.seenSweepEveryMs) return 0;
    this.lastSeenSweep = now;
    return this.seen.sweep(now, this.seenSweepLimit);
  }

  async sweep() {
    try { this.sweepSeen(); } catch (err) { this.logStore(err); }
    const expired = this.parts.expired(this.now(), this.partWindowMs);
    const results = [];
    for (const rid of expired) {
      results.push(await this.reject(null, 'parts_timeout', true, rid));
    }
    return results;
  }
}

module.exports = {
  MAX_CONTENT_CHARS,
  MAX_DECODED_BYTES,
  MAX_PARTS,
  MAX_SKEW_MS,
  PART_WINDOW_MS,
  NONCE_TTL_MS,
  SEEN_TTL_MS,
  SEEN_SWEEP_LIMIT,
  SEEN_SWEEP_EVERY_MS,
  ALERT_WINDOW_MS,
  ROTATION_WINDOW_MS,
  envelopeConfigured,
  selectKeys,
  verifyEnvelope,
  decodeBase64Url,
  parseEnvelopeJson,
  extractPayload,
  looksLikeEnvelope,
  NonceStore,
  PartStore,
  SeenIds,
  EnvelopeIngress,
};
