'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  assertReady,
  resolveIntentBits,
  createBridgeClient,
  permissionInteger,
  PRESETS,
  redact,
  createLogger,
  REQUIRED_INTENTS,
} = require('../discord-bridge');
const { main } = require('../scripts/perm-calc');
const { tempDir, rmrf } = require('./helpers');

describe('config, intents, and permissions', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  it('ships placeholders, stays disabled, and refuses to start enabled until they are replaced', () => {
    const loaded = loadConfig({ env: {} });
    assert.equal(loaded.config.features.enabled, false);
    assert.deepEqual(loaded.config.discord.intents, ['Guilds', 'GuildMessages']);
    assert.equal(loaded.config.discord.guildIds[0], 'YOUR_GUILD_ID');
    assert.throws(() => assertReady({
      ...loaded.config,
      features: { ...loaded.config.features, enabled: true },
    }), /YOUR_/);

    const root = tempDir('phicc-config-');
    dirs.push(root);
    const localPath = path.join(root, 'config.local.json');
    const example = path.join(root, 'config.example.json');
    fs.writeFileSync(example, fs.readFileSync(path.join(__dirname, '..', 'config.example.json')));
    fs.writeFileSync(localPath, JSON.stringify({
      features: { enabled: true },
      discord: {
        applicationId: '123',
        guildIds: ['111'],
        channelIds: ['222'],
        allowedUserIds: ['333'],
      },
    }));
    fs.chmodSync(localPath, 0o644);
    const loose = loadConfig({ root, env: {} });
    assert.throws(() => assertReady(loose.config, { localPath: loose.localPath }), /chmod 600/);
    fs.chmodSync(localPath, 0o600);
    const tight = loadConfig({ root, env: {} });
    assert.doesNotThrow(() => assertReady(tight.config, { localPath: tight.localPath }));
    assert.equal(tight.config.features.enabled, true);
    assert.equal(tight.config.discord.guildIds[0], '111');
  });

  it('lets DBR_ env vars override the example file', () => {
    const root = tempDir('phicc-env-');
    dirs.push(root);
    fs.copyFileSync(path.join(__dirname, '..', 'config.example.json'), path.join(root, 'config.example.json'));
    const { config } = loadConfig({
      root,
      env: {
        DBR_FEATURES_ENABLED: 'true',
        DBR_DISCORD_GUILDIDS: '10,11',
        DBR_QUEUE_DIR: '/tmp/phicc-queue-example',
      },
    });
    assert.equal(config.features.enabled, true);
    assert.deepEqual(config.discord.guildIds, ['10', '11']);
    assert.equal(config.queue.dir, '/tmp/phicc-queue-example');
  });

  it('requests exactly intents 513 and rejects message content', () => {
    assert.equal(resolveIntentBits(['Guilds', 'GuildMessages']), 513);
    assert.equal(resolveIntentBits(['GUILD_MESSAGES', 'GUILDS']), REQUIRED_INTENTS);
    assert.throws(() => resolveIntentBits(['Guilds', 'GuildMessages', 'MessageContent']), /disallowed intent/);
    assert.throws(() => resolveIntentBits(513 + 32768), /exactly/);
    const client = createBridgeClient(require('discord.js'), {
      discord: { intents: ['Guilds', 'GuildMessages'] },
    });
    try {
      const intents = client.options.intents;
      const bits = typeof intents === 'number' ? intents : intents.bitfield;
      assert.equal(bits, 513);
    } finally {
      client.destroy();
    }
  });

  it('documents 68608 and 85056 and refuses ADMINISTRATOR', () => {
    assert.equal(PRESETS.base, 68608);
    assert.equal(PRESETS.embedsAndReactions, 85056);
    assert.equal(PRESETS.withThreads, 274877992000);
    assert.equal(permissionInteger(['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY']), 68608);
    assert.throws(() => permissionInteger(['SEND_MESSAGES', 'ADMINISTRATOR']), /never allowed/);
    const logged = [];
    const original = console.log;
    const originalError = console.error;
    console.log = (line) => logged.push(String(line));
    console.error = (line) => logged.push(String(line));
    try {
      const code = main(['node', 'perm-calc.js', 'ADMINISTRATOR']);
      assert.equal(code, null);
      assert.equal(process.exitCode, 2);
      assert.match(logged.join('\n'), /never allowed/);
    } finally {
      process.exitCode = undefined;
      console.log = original;
      console.error = originalError;
    }
  });

  it('redacts tokens in logs and omits message bodies at info level', () => {
    const token = `${'D'.repeat(24)}.${'E'.repeat(6)}.${'F'.repeat(27)}`;
    assert.equal(redact(`prefix ${token} Bearer ${'g'.repeat(20)}`).includes(token), false);
    const lines = [];
    const logger = createLogger({
      level: 'info',
      logBodies: false,
      stream: { write: (line) => lines.push(line) },
    });
    logger.info({ event: 'sample', token, text: 'secret body', key: 'webhook-key' });
    const written = lines.join('');
    assert.equal(written.includes(token), false);
    assert.equal(written.includes('secret body'), false);
    assert.equal(written.includes('webhook-key'), false);
    assert.match(written, /\[redacted\]/);
  });
});
