'use strict';

const { errorFields } = require('./log');

const DAY_MS = 24 * 60 * 60 * 1000;
const IDENTIFY_WARN_AT = 50;

function nextBackoffMs(attempt, options = {}) {
  const base = options.base || 1000;
  const cap = options.cap || 60000;
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(cap, base * (2 ** (n - 1)));
}

function noteIdentify(state, now) {
  const stamp = now == null ? Date.now() : now;
  state.identifies = (state.identifies || []).filter((t) => stamp - t < DAY_MS);
  state.identifies.push(stamp);
  return {
    count: state.identifies.length,
    warn: state.identifies.length > IDENTIFY_WARN_AT,
  };
}

/**
 * Observe gateway lifecycle. discord.js resumes on its own; this does not
 * open a second identify loop (1000 IDENTIFYs in 24h resets the token).
 */
function trackGateway(client, log, state) {
  const bucket = state || { identifies: [] };
  const onReady = () => {
    const result = noteIdentify(bucket, Date.now());
    log.info({ event: 'gateway_ready', identifiesToday: result.count });
    if (result.warn) {
      log.warn({
        event: 'identify_budget',
        identifiesToday: result.count,
        warnAt: IDENTIFY_WARN_AT,
      });
    }
  };
  const code = (value) => (value && value.code != null ? Number(value.code) || String(value.code) : undefined);
  client.on('ready', onReady);
  client.on('shardReady', (shardId) => log.info({ event: 'gateway_shard_ready', shardId }));
  client.on('shardResume', (shardId, replayed) => log.info({
    event: 'gateway_resume',
    shardId,
    replayed: Number.isFinite(replayed) ? replayed : undefined,
  }));
  client.on('shardDisconnect', (closeEvent, shardId) => log.warn({
    event: 'gateway_disconnect',
    shardId,
    closeCode: code(closeEvent),
  }));
  client.on('shardReconnecting', (shardId) => log.info({ event: 'gateway_reconnecting', shardId }));
  client.on('shardError', (err, shardId) => log.warn({ event: 'gateway_shard_error', shardId, ...errorFields(err) }));
  // 'warn' strings are not logged: only that one happened. Never attach to 'debug'.
  client.on('warn', () => log.warn({ event: 'gateway_warn' }));
  client.on('error', (err) => log.warn({ event: 'gateway_error', ...errorFields(err) }));
  return bucket;
}

module.exports = {
  DAY_MS,
  IDENTIFY_WARN_AT,
  nextBackoffMs,
  noteIdentify,
  trackGateway,
};
