'use strict';

const fs = require('fs');
const path = require('path');
const { errorFields } = require('./log');

/** discord.js v13 Status values. 0 is READY. */
const STATUS_NAMES = Object.freeze({
  0: 'READY',
  1: 'CONNECTING',
  2: 'RECONNECTING',
  3: 'IDLE',
  4: 'NEARLY',
  5: 'DISCONNECTED',
  6: 'WAITING_FOR_GUILDS',
  7: 'IDENTIFYING',
  8: 'RESUMING',
});

const DEFAULTS = Object.freeze({
  // How often the monitor checks and rewrites the heartbeat file.
  intervalMs: 15000,
  // Discord sends a heartbeat ACK about every 41 s, so 150 s is more than 3 missed ACKs.
  staleMs: 150000,
  // Not READY for this long after start or after any drop.
  notReadyMs: 180000,
  // A tick that arrives this late means the machine was paused or the event loop was blocked.
  sleepGapMs: 90000,
});

function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Watches gateway liveness. Records when the last gateway packet arrived (heartbeat
 * ACKs included), never its contents. Calls onStale(reason) once when the
 * connection is a zombie, stuck not READY, invalidated, or the box was asleep.
 */
class GatewayMonitor {
  constructor(options) {
    this.client = options.client;
    this.log = options.log;
    this.file = options.heartbeatFile || null;
    this.now = options.now || Date.now;
    this.onStale = options.onStale || null;
    this.intervalMs = options.intervalMs || DEFAULTS.intervalMs;
    this.staleMs = options.staleMs || DEFAULTS.staleMs;
    this.notReadyMs = options.notReadyMs || DEFAULTS.notReadyMs;
    this.sleepGapMs = options.sleepGapMs || DEFAULTS.sleepGapMs;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    const start = this.now();
    this.startedAt = start;
    this.lastPacketAt = null;
    this.lastReadyAt = null;
    this.lastResumeAt = null;
    this.notReadySince = start;
    this.lastTickAt = start;
    this.tripped = null;
    this.timer = null;
    this.listeners = [];
  }

  on(event, fn) {
    this.client.on(event, fn);
    this.listeners.push([event, fn]);
  }

  start() {
    this.on('raw', () => { this.lastPacketAt = this.now(); });
    this.on('ready', () => { this.lastReadyAt = this.now(); this.notReadySince = null; });
    this.on('shardReady', () => { this.lastReadyAt = this.now(); this.notReadySince = null; });
    this.on('shardResume', () => { this.lastResumeAt = this.now(); this.notReadySince = null; });
    // Listening to 'invalidated' tells discord.js the owner handles shutdown. Only the
    // standalone process uses this monitor, and it exits for the supervisor.
    this.on('invalidated', () => { this.log.error({ event: 'gateway_invalidated' }); this.trip('invalidated'); });
    this.timer = this.setInterval(() => this.tick(), this.intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    this.writeFile(this.snapshot());
    return this;
  }

  stop() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
    for (const [event, fn] of this.listeners) this.client.removeListener(event, fn);
    this.listeners = [];
  }

  status() {
    const ws = this.client && this.client.ws;
    if (!ws || typeof ws.status !== 'number') return null;
    return ws.status;
  }

  ping() {
    const ws = this.client && this.client.ws;
    const value = ws ? Number(ws.ping) : NaN;
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }

  snapshot(reason) {
    const now = this.now();
    const status = this.status();
    return {
      ts: now,
      iso: new Date(now).toISOString(),
      pid: process.pid,
      status,
      statusName: status == null ? 'UNKNOWN' : (STATUS_NAMES[status] || String(status)),
      ping: this.ping(),
      startedAt: this.startedAt,
      lastPacketAt: this.lastPacketAt,
      lastReadyAt: this.lastReadyAt,
      lastResumeAt: this.lastResumeAt,
      healthy: !this.tripped && !reason,
      reason: this.tripped || reason || null,
    };
  }

  /** Returns null when healthy, else a short reason string. */
  evaluate(now) {
    const gap = now - this.lastTickAt;
    if (gap > this.sleepGapMs) return 'sleep_gap';
    const status = this.status();
    if (status === 0) {
      this.notReadySince = null;
    } else if (this.notReadySince == null) {
      this.notReadySince = now;
    }
    if (this.notReadySince != null && now - this.notReadySince > this.notReadyMs) return 'not_ready';
    const since = this.lastPacketAt == null ? this.startedAt : this.lastPacketAt;
    if (now - since > this.staleMs) return 'no_gateway_packets';
    return null;
  }

  tick() {
    const now = this.now();
    let reason = null;
    try {
      reason = this.evaluate(now);
    } catch (err) {
      this.log.warn({ event: 'liveness_check_failed', ...errorFields(err) });
    }
    const gapMs = now - this.lastTickAt;
    this.lastTickAt = now;
    if (reason) {
      this.trip(reason, { gapMs: reason === 'sleep_gap' ? gapMs : undefined });
      return reason;
    }
    this.writeFile(this.snapshot());
    return null;
  }

  trip(reason, extra = {}) {
    if (this.tripped) return;
    this.tripped = reason;
    const snap = this.snapshot(reason);
    this.log.error({
      event: 'gateway_stale',
      reason,
      statusName: snap.statusName,
      ping: snap.ping,
      lastPacketAgoMs: this.lastPacketAt == null ? null : snap.ts - this.lastPacketAt,
      ...extra,
    });
    this.writeFile(snap);
    if (this.onStale) {
      try {
        this.onStale(reason);
      } catch (err) {
        this.log.error({ event: 'liveness_on_stale_failed', ...errorFields(err) });
      }
    }
  }

  writeFile(snap) {
    if (!this.file) return;
    try {
      writeAtomic(this.file, `${JSON.stringify(snap)}\n`);
    } catch (err) {
      this.log.warn({ event: 'heartbeat_write_failed', ...errorFields(err) });
    }
  }
}

/**
 * Used by the watchdog. Returns { ok, reason } for a heartbeat file.
 * maxAgeMs: the file itself must be this fresh (process alive and its loop running).
 * maxPacketAgeMs: the last gateway packet must be this fresh.
 */
function checkHeartbeatFile(file, options = {}) {
  const now = options.now == null ? Date.now() : options.now;
  const maxAgeMs = options.maxAgeMs || 120000;
  const maxPacketAgeMs = options.maxPacketAgeMs || 180000;
  const graceMs = options.startupGraceMs || 180000;
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!snap || typeof snap.ts !== 'number') return { ok: false, reason: 'unreadable' };
  if (options.pid != null && Number(snap.pid) !== Number(options.pid)) {
    // Written by an older process. Allow a fresh process time to write its first file.
    return { ok: false, reason: 'other_pid', pid: snap.pid };
  }
  if (snap.healthy === false) return { ok: false, reason: snap.reason || 'unhealthy' };
  if (now - snap.ts > maxAgeMs) return { ok: false, reason: 'file_stale', ageMs: now - snap.ts };
  const since = typeof snap.lastPacketAt === 'number' ? snap.lastPacketAt : null;
  if (since == null) {
    if (now - (snap.startedAt || snap.ts) > graceMs) return { ok: false, reason: 'never_connected' };
    return { ok: true, reason: 'starting' };
  }
  if (now - since > maxPacketAgeMs) return { ok: false, reason: 'gateway_stale', ageMs: now - since };
  return { ok: true, reason: snap.statusName || 'ok' };
}

module.exports = {
  DEFAULTS,
  STATUS_NAMES,
  GatewayMonitor,
  checkHeartbeatFile,
};
