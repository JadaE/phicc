'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { delayMs, planStart, noteExit, MIN_DELAY_MS, MAX_DELAY_MS } = require('../discord-bridge');
const { main } = require('../deploy/nas/entrypoint');
const { tempDir, rmrf } = require('./helpers');

describe('restart backoff', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('waits at least 2s and reaches 5 min after 5 fast failures', () => {
    assert.equal(delayMs(0), MIN_DELAY_MS);
    assert.equal(delayMs(1), 2000);
    assert.equal(delayMs(2), 4000);
    assert.equal(delayMs(4), 16000);
    assert.equal(delayMs(5), MAX_DELAY_MS);
    assert.equal(delayMs(9), 300000);
  });

  it('alerts after 3 restarts in 10 minutes and not outside the window', () => {
    let state = { fastFailures: 0, starts: [], lastAlertAt: 0 };
    const start = 1_700_000_000_000;
    let alertAt = null;
    for (let n = 0; n < 3; n += 1) {
      const plan = planStart(state, start + n * 1000);
      state = plan.state;
      if (plan.alert) alertAt = n;
    }
    assert.equal(alertAt, 2);
    const later = planStart({ fastFailures: 0, starts: [start], lastAlertAt: 0 }, start + 11 * 60 * 1000);
    assert.equal(later.alert, false);
    assert.equal(later.restartsInWindow, 1);
  });

  it('resets the fast-failure count after a long run and alerts from the entrypoint', async () => {
    const reset = noteExit({ fastFailures: 4, starts: [] }, 120000, 1);
    assert.equal(reset.fastFailures, 0);
    const fast = noteExit({ fastFailures: 1, starts: [] }, 1000, 1);
    assert.equal(fast.fastFailures, 2);

    const root = tempDir('phicc-restart-');
    dirs.push(root);
    const sleeps = [];
    const alerts = [];
    let clock = 1_700_000_000_000;
    const secret = 'alert-webhook-must-not-leak';
    await main({
      statePath: path.join(root, 'restarts.json'),
      steps: 6,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      run: async () => 1,
      alerter: {
        send: async (entry) => {
          alerts.push(entry);
          return entry;
        },
      },
    });
    assert.equal(sleeps[0], 2000);
    assert.equal(sleeps[5], 300000);
    assert.equal(alerts.some((entry) => entry.reason === 'restart_storm'), true);
    assert.equal(JSON.stringify(alerts).includes(secret), false);
    const stored = fs.readFileSync(path.join(root, 'restarts.json'), 'utf8');
    assert.equal(stored.includes(secret), false);
  });
});
