'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/;

function walk(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'queue' || entry.name === 'logs') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (/\.(js|json|md|yml|yaml|toml|txt)$/.test(entry.name) || entry.name === '.gitignore') {
      found.push(full);
    }
  }
}

describe('repo secret guards', () => {
  it('gitignores auth.json, config.local.json, and .env', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const name of ['auth.json', 'config.local.json', '.env']) {
      assert.match(ignore, new RegExp(`^${name}$`, 'm'));
    }
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    for (const name of ['auth.json', 'config.local.json', '.env']) {
      assert.equal(tracked.split('\n').includes(name), false);
    }
  });

  it('does not commit a discord token or a webhook key', () => {
    const files = [];
    walk(ROOT, files);
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (TOKEN_RE.test(text)) hits.push(path.relative(ROOT, file));
      if (/COMMS_WEBHOOK_KEY\s*[:=]\s*['\"]?[A-Za-z0-9_+\/=]{16,}/.test(text)) {
        hits.push(`${path.relative(ROOT, file)} webhook key`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('keeps the standalone bridge from logging in while disabled', () => {
    const { main } = require('../bridge');
    const result = main({
      config: {
        features: { enabled: false },
        discord: { tokenEnv: 'DISCORD_TOKEN_DEV' },
        wake: {},
        policy: { ignorePrefixes: ['!!'] },
        queue: { dir: '/tmp/unused' },
        logging: { level: 'info', dir: '/tmp/unused-logs', logBodies: false },
      },
    });
    assert.equal(result.started, false);
    assert.equal(result.reason, 'disabled');
  });
});
