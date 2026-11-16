'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tokenHash(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

class BridgeLock {
  constructor(options = {}) {
    this.queueDir = options.queueDir;
    this.token = options.token || '';
    this.tokenLockDir = options.tokenLockDir || path.join(os.homedir(), '.discord-bridge', 'locks');
    this.holdId = crypto.randomBytes(8).toString('hex');
    this.held = [];
  }

  acquire() {
    const local = path.join(this.queueDir, 'state', 'bridge.lock');
    this.acquireFile(local, tokenHash(this.token));
    if (this.token) {
      const globalFile = path.join(this.tokenLockDir, `${tokenHash(this.token)}.lock`);
      try {
        this.acquireFile(globalFile, tokenHash(this.token));
      } catch (err) {
        this.release();
        throw err;
      }
    }
  }

  acquireFile(file, hash) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(file), 0o700); } catch (err) { /* best effort */ }
    if (fs.existsSync(file)) {
      let current = {};
      try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { current = {}; }
      if (current.pid && pidAlive(current.pid) && current.holdId !== this.holdId) {
        const error = new Error('BRIDGE_LOCK');
        error.name = 'BridgeLockError';
        error.code = 'BRIDGE_LOCK';
        throw error;
      }
    }
    const payload = {
      pid: process.pid,
      holdId: this.holdId,
      tokenHash: hash,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    this.held.push(file);
  }

  release() {
    while (this.held.length) {
      const file = this.held.pop();
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current.pid === process.pid) fs.unlinkSync(file);
      } catch (err) { /* already gone */ }
    }
  }
}

module.exports = { BridgeLock, pidAlive, tokenHash };
