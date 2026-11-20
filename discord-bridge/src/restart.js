'use strict';

const fs = require('fs');
const path = require('path');

// Ported from scripts/supervise.sh: wait at least 2s, and 5 min after 5 fast failures.
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const FAST_FAILURES_BEFORE_MAX = 5;
const FAST_RUNTIME_MS = 60 * 1000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_ALERT_AT = 3;

function delayMs(fastFailures) {
  const fails = Math.max(0, Math.floor(Number(fastFailures) || 0));
  if (fails >= FAST_FAILURES_BEFORE_MAX) return MAX_DELAY_MS;
  if (fails <= 0) return MIN_DELAY_MS;
  const seconds = 2 ** fails;
  return Math.min(300, seconds) * 1000;
}

function blankState() {
  return { fastFailures: 0, starts: [], lastAlertAt: 0 };
}

function planStart(state, now) {
  const stamp = now == null ? Date.now() : now;
  const current = state && typeof state === 'object' ? state : blankState();
  if (!Array.isArray(current.starts)) current.starts = [];
  current.fastFailures = Math.max(0, Math.floor(Number(current.fastFailures) || 0));
  current.starts = current.starts.filter((item) => stamp - Number(item) < RESTART_WINDOW_MS);
  current.starts.push(stamp);
  let alert = false;
  if (current.starts.length >= RESTART_ALERT_AT) {
    const last = Number(current.lastAlertAt) || 0;
    if (!last || stamp - last >= RESTART_WINDOW_MS) {
      alert = true;
      current.lastAlertAt = stamp;
    }
  }
  return {
    state: current,
    delayMs: delayMs(current.fastFailures),
    alert,
    restartsInWindow: current.starts.length,
  };
}

function noteExit(state, runtimeMs, code) {
  const current = state && typeof state === 'object' ? state : blankState();
  const runtime = Number(runtimeMs) || 0;
  const failedFast = Number(code) !== 0 && runtime < FAST_RUNTIME_MS;
  current.fastFailures = failedFast ? (Math.floor(Number(current.fastFailures) || 0) + 1) : 0;
  return current;
}

function loadState(file) {
  try {
    if (!file || !fs.existsSync(file)) return blankState();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return blankState();
    return {
      fastFailures: Math.max(0, Math.floor(Number(data.fastFailures) || 0)),
      starts: Array.isArray(data.starts) ? data.starts.map(Number).filter((n) => Number.isFinite(n)) : [],
      lastAlertAt: Number(data.lastAlertAt) || 0,
    };
  } catch (err) {
    return blankState();
  }
}

function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (err) { /* best effort */ }
}

/**
 * One supervisor step. `run` returns an exit code. Secrets are not read here
 * and the alert payload is a fixed reason code.
 */
async function superviseOnce(options) {
  const now = options.now || (() => Date.now());
  const state = loadState(options.statePath);
  const plan = planStart(state, now());
  saveState(options.statePath, plan.state);
  if (plan.delayMs > 0 && typeof options.sleep === 'function') await options.sleep(plan.delayMs);
  if (plan.alert && typeof options.alert === 'function') {
    await options.alert({
      level: 'P0',
      reason: 'restart_storm',
      restartsInWindow: plan.restartsInWindow,
    });
  }
  const started = now();
  const code = await options.run();
  const after = loadState(options.statePath);
  noteExit(after, now() - started, code);
  saveState(options.statePath, after);
  return { code, delayMs: plan.delayMs, alert: plan.alert, fastFailures: after.fastFailures };
}

module.exports = {
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  FAST_FAILURES_BEFORE_MAX,
  FAST_RUNTIME_MS,
  RESTART_WINDOW_MS,
  RESTART_ALERT_AT,
  delayMs,
  blankState,
  planStart,
  noteExit,
  loadState,
  saveState,
  superviseOnce,
};
