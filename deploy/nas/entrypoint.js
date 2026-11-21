'use strict';

// NAS process supervisor. Sleeps at least 2s between starts and backs off to
// 5 min after 5 fast failures. Writes
// a P0 alert after 3 starts in 10 minutes. Secret values stay in files.

const path = require('path');
const { spawn } = require('child_process');
const { superviseOnce } = require('../../discord-bridge/src/restart');
const { Alerter } = require('../../discord-bridge/src/alert');
const { secretValue } = require('../../discord-bridge/src/secrets');

function bridgeChild() {
  const script = process.env.DBR_BRIDGE_SCRIPT
    || path.join(__dirname, '..', '..', 'bridge.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (signal) resolve(1);
      else resolve(code == null ? 1 : code);
    });
    child.on('error', () => resolve(1));
  });
}

function optionalSecret(name) {
  try {
    return secretValue(process.env, name);
  } catch (err) {
    return '';
  }
}

async function main(options = {}) {
  const stateDir = process.env.DBR_STATE_DIR || '/srv/ssd1/discord-bridge/state';
  const queueDir = process.env.DBR_QUEUE_DIR || '/srv/ssd1/discord-bridge/queue';
  const statePath = options.statePath || path.join(stateDir, 'restarts.json');
  const run = options.run || bridgeChild;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }));
  const alerter = options.alerter || new Alerter({
    dir: path.join(queueDir, 'alerts'),
    url: optionalSecret('ALERT_WEBHOOK_URL'),
    key: optionalSecret('ALERT_WEBHOOK_KEY'),
    // Empty is not every HTTPS host. parseHttpsWebhook fails closed without a list.
    allowedHosts: String(process.env.DBR_WAKE_ALLOWEDHOSTS || '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  });
  const steps = options.steps == null ? Infinity : options.steps;
  let count = 0;
  const results = [];
  while (count < steps) {
    count += 1;
    const result = await superviseOnce({
      statePath,
      now: options.now,
      run,
      sleep,
      alert: (entry) => alerter.send({ ...entry, at: new Date().toISOString() }),
    });
    results.push(result);
    if (typeof options.shouldStop === 'function' && options.shouldStop(result, count)) break;
  }
  return results;
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = { main, bridgeChild };
