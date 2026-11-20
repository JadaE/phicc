'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { secretValue, resolveSecrets } = require('../discord-bridge');
const { assertReady, defaultConfig, merge } = require('../discord-bridge');
const { createLogger } = require('../discord-bridge');
const { redactSecrets } = require('../discord-bridge');
const { tempDir, rmrf } = require('./helpers');

describe('file secrets', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('reads NAME_FILE without copying the secret into the environment', () => {
    const root = tempDir('phicc-secret-');
    dirs.push(root);
    const secret = 'queue-hmac-from-file';
    const file = path.join(root, 'queue_hmac');
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    const env = { QUEUE_HMAC_KEY_FILE: file, PATH: '/usr/bin' };
    assert.equal(secretValue(env, 'QUEUE_HMAC_KEY'), secret);
    assert.equal(env.QUEUE_HMAC_KEY, undefined);
    assert.equal(JSON.stringify(env).includes(secret), false);
    const resolved = resolveSecrets(env, ['QUEUE_HMAC_KEY']);
    assert.equal(resolved.QUEUE_HMAC_KEY, secret);
    assert.equal(JSON.stringify(env).includes(secret), false);
  });

  it('prefers the file over a direct env value and still accepts the box env', () => {
    const root = tempDir('phicc-secret-');
    dirs.push(root);
    const file = path.join(root, 'token');
    fs.writeFileSync(file, 'file-token-value\n', { mode: 0o600 });
    const env = { DISCORD_TOKEN: 'env-token-value', DISCORD_TOKEN_FILE: file };
    assert.equal(secretValue(env, 'DISCORD_TOKEN'), 'file-token-value');
    assert.equal(secretValue({ DISCORD_TOKEN: 'env-token-value' }, 'DISCORD_TOKEN'), 'env-token-value');
  });

  it('accepts webhook settings from files and does not log the secret', () => {
    const root = tempDir('phicc-secret-');
    dirs.push(root);
    const urlFile = path.join(root, 'url');
    const keyFile = path.join(root, 'key');
    const hmacFile = path.join(root, 'hmac');
    fs.writeFileSync(urlFile, 'https://hooks.example/wake\n');
    fs.writeFileSync(keyFile, 'test-webhook-key\n');
    fs.writeFileSync(hmacFile, 'test-hmac-key-value\n');
    const env = {
      COMMS_WEBHOOK_URL_FILE: urlFile,
      COMMS_WEBHOOK_KEY_FILE: keyFile,
      QUEUE_HMAC_KEY_FILE: hmacFile,
    };
    const config = merge(defaultConfig(), {
      features: { enabled: true, killSwitchFile: path.join(root, 'STOP') },
      discord: {
        applicationId: '100000000000000999',
        guildIds: ['100000000000000111'],
        channelIds: ['100000000000000222'],
        allowedUserIds: ['100000000000000333'],
        allowedRoleIds: [],
      },
      wake: { allowedHosts: ['hooks.example'] },
      policy: { usersOnly: true, requireMention: true },
    });
    assert.doesNotThrow(() => assertReady(config, { env }));
    assert.equal(JSON.stringify(env).includes('test-webhook-key'), false);
    const lines = [];
    const logger = createLogger({
      level: 'info',
      logBodies: false,
      stream: { write: (line) => lines.push(line) },
    });
    logger.info({ event: 'boot', key: secretValue(env, 'COMMS_WEBHOOK_KEY') });
    const written = lines.join('');
    assert.equal(written.includes('test-webhook-key'), false);
    const redacted = redactSecrets(`body ${secretValue(env, 'QUEUE_HMAC_KEY')}`, [
      secretValue(env, 'QUEUE_HMAC_KEY'),
    ]);
    assert.equal(redacted.includes('test-hmac-key-value'), false);
  });

  it('greps logs without printing the secret', () => {
    const root = tempDir('phicc-grep-');
    dirs.push(root);
    const secret = 'unique-envelope-hmac-value';
    const secretFile = path.join(root, 'secret');
    const cleanLog = path.join(root, 'clean.log');
    const dirtyLog = path.join(root, 'dirty.log');
    fs.writeFileSync(secretFile, `${secret}\n`);
    fs.writeFileSync(cleanLog, '{"event":"boot","level":"info"}\n');
    fs.writeFileSync(dirtyLog, `{"event":"boot"} ${secret}\n`);
    const script = path.join(__dirname, '..', 'scripts', 'grep-secrets.sh');
    const clean = execFileSync('sh', [script, cleanLog, secretFile], { encoding: 'utf8' });
    assert.match(clean, /"result":"clean"/);
    assert.equal(clean.includes(secret), false);
    let dirty = '';
    let status = 0;
    try {
      dirty = execFileSync('sh', [script, dirtyLog, secretFile], { encoding: 'utf8' });
    } catch (err) {
      status = err.status;
      dirty = `${err.stdout || ''}`;
    }
    assert.equal(status, 1);
    assert.match(dirty, /"result":"secret-hit"/);
    assert.equal(dirty.includes(secret), false);
    const history = path.join(__dirname, '..', 'scripts', 'check-image-history.sh');
    const documented = execFileSync('sh', [history, 'discord-bridge:nas'], {
      encoding: 'utf8',
      env: { ...process.env, ALLOW_NO_DOCKER: '1' },
    });
    assert.match(documented, /docker_history/);
    assert.equal(documented.includes(secret), false);
    const scriptText = fs.readFileSync(history, 'utf8');
    assert.match(scriptText, /docker history --no-trunc/);
  });
});
