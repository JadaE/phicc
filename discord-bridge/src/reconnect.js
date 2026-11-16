'use strict';

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
  client.on('ready', onReady);
  client.on('shardResume', () => log.info({ event: 'gateway_resume' }));
  client.on('shardDisconnect', () => log.info({ event: 'gateway_disconnect' }));
  client.on('error', () => log.warn({ event: 'gateway_error' }));
  return bucket;
}

module.exports = {
  DAY_MS,
  IDENTIFY_WARN_AT,
  nextBackoffMs,
  noteIdentify,
  trackGateway,
};
