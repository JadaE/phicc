'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { main } = require('../discord-bridge/standalone');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['ensure', 'supervise', 'watchdog'];

describe('RETIRED marker on the live box scripts', () => {
  it('makes ensure, supervise, and watchdog exit 78', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phicc-retired-'));
    const marker = path.join(dir, 'RETIRED');
    fs.writeFileSync(marker, 'retired\n');
    try {
      for (const name of SCRIPTS) {
        const blocked = spawnSync('bash', [path.join(ROOT, 'discord-bridge', 'scripts', `${name}.sh`)], {
          encoding: 'utf8',
          env: {
            ...process.env,
            DBR_RETIRED_FILE: marker,
            BRIDGE_DIR: dir,
            HOME: dir,
          },
        });
        assert.equal(blocked.status, 78, name);
        assert.match(blocked.stderr, /retired/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes the standalone start path refuse before login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phicc-retired-start-'));
    const marker = path.join(dir, 'RETIRED');
    fs.writeFileSync(marker, 'retired\n');
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    try {
      const result = main({ env: { DBR_RETIRED_FILE: marker } });
      assert.equal(result.started, false);
      assert.equal(result.reason, 'retired');
      assert.match(lines.join('\n'), /retired/);
      assert.equal(lines.join('\n').includes('login'), false);
    } finally {
      console.error = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
