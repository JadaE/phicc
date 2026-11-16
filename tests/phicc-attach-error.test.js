'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phicc-attach-'));
const lines = [];
console.error = (line) => lines.push(String(line));
process.env.PHICC_BRIDGE_ENABLED = 'true';
process.env.DBR_FEATURES_ENABLED = 'true';
process.env.DBR_QUEUE_DIR = path.join(root, 'queue');
process.env.DBR_FEATURES_KILLSWITCHFILE = path.join(root, 'STOP');
process.env.DBR_LOGGING_DIR = path.join(root, 'logs');
process.env.DBR_DISCORD_GUILDIDS = '100000000000000111';
process.env.DBR_DISCORD_CHANNELIDS = '100000000000000222';
process.env.DBR_DISCORD_ALLOWEDUSERIDS = '100000000000000333';
process.env.DBR_DISCORD_APPLICATIONID = '100000000000000999';
process.env.DBR_WAKE_ALLOWEDHOSTS = 'hooks.example';
process.env.COMMS_WEBHOOK_URL = 'http://hooks.example/wake';
process.env.COMMS_WEBHOOK_KEY = 'test-webhook-key';
process.env.QUEUE_HMAC_KEY = 'test-hmac-key-value';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { bot, onMessageCreate } = require('../bot');

describe('adapter attach failure', () => {
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    bot.destroy();
  });

  it('logs the error code and leaves !! commands in place', () => {
    assert.equal(bot.phiccBridge, undefined);
    const logged = lines.join('\n');
    assert.match(logged, /bridge_attach_failed/);
    assert.match(logged, /WEBHOOK_HTTPS/);
    assert.equal(logged.includes('test-webhook-key'), false);
    let called = 0;
    const command = bot.commands.get('rulereader');
    const original = command.execute;
    command.execute = () => { called += 1; };
    try {
      onMessageCreate({ content: '!!rulereader', author: { id: '1', bot: false } });
    } finally {
      command.execute = original;
    }
    assert.equal(called, 1);
  });
});
