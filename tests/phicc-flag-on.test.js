'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phicc-flag-on-'));
process.env.PHICC_BRIDGE_ENABLED = 'true';
process.env.DBR_FEATURES_ENABLED = 'true';
process.env.DBR_QUEUE_DIR = path.join(root, 'queue');
process.env.DBR_FEATURES_KILLSWITCHFILE = path.join(root, 'STOP');
process.env.DBR_LOGGING_DIR = path.join(root, 'logs');
process.env.DBR_DISCORD_GUILDIDS = '111';
process.env.DBR_DISCORD_CHANNELIDS = '222';
process.env.DBR_DISCORD_ALLOWEDUSERIDS = '333';
process.env.DBR_DISCORD_APPLICATIONID = '999';
process.env.DBR_DISCORD_BOTUSERID = '444';
delete process.env.COMMS_WEBHOOK_URL;
delete process.env.COMMS_WEBHOOK_KEY;

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { bot, onMessageCreate } = require('../bot');

function mention(id, content) {
  return {
    id,
    content,
    author: { id: '333', bot: false, username: 'jada' },
    member: { displayName: 'Jada', roles: { cache: { has: () => false } } },
    guildId: '111',
    channelId: '222',
    channel: { id: '222', isThread: () => false },
    webhookId: null,
    createdTimestamp: 1700000000000,
    mentions: {
      everyone: false,
      users: { has: (userId) => content.includes(`<@${userId}>`) || content.includes(`<@!${userId}>`) },
      roles: { has: () => false },
    },
    react: async () => {},
    reply: async () => ({}),
  };
}

async function deliver(message) {
  const tasks = [];
  for (const listener of bot.listeners('messageCreate')) {
    const result = listener(message);
    if (result && typeof result.then === 'function') tasks.push(result);
  }
  await Promise.all(tasks);
}

describe('Phicc with the bridge flag on', () => {
  after(() => {
    if (bot.phiccBridge) bot.phiccBridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
    bot.destroy();
  });

  it('keeps !! commands on the old path and sends mentions only to the bridge', async () => {
    assert.ok(bot.phiccBridge);
    assert.equal(bot.listenerCount('messageCreate'), 2);
    bot.user = { id: '444' };
    const seen = [];
    const command = bot.commands.get('rulereader');
    const original = command.execute;
    command.execute = (message) => seen.push(message.content);
    try {
      await deliver(mention('8001', '!!rulereader'));
      await deliver(mention('8002', '<@444> hello from discord'));
    } finally {
      command.execute = original;
    }
    assert.deepEqual(seen, ['!!rulereader']);
    const inbox = path.join(root, 'queue', 'inbox');
    const files = fs.readdirSync(inbox).filter((name) => name.endsWith('.json'));
    assert.deepEqual(files, ['8002.json']);
    const stored = JSON.parse(fs.readFileSync(path.join(inbox, '8002.json'), 'utf8'));
    assert.equal(stored.text, 'hello from discord');
    assert.equal(fs.existsSync(path.join(inbox, '8001.json')), false);
  });

  it('still runs !!reactionroletest while the kill switch silences mentions', async () => {
    fs.writeFileSync(process.env.DBR_FEATURES_KILLSWITCHFILE, 'stop\n');
    const seen = [];
    const command = bot.commands.get('reactionroletest');
    const original = command.execute;
    command.execute = (message, args) => seen.push({ content: message.content, args });
    try {
      onMessageCreate({ content: '!!reactionroletest', author: { id: '333', bot: false } });
      await deliver(mention('8003', '<@444> are you there'));
    } finally {
      command.execute = original;
    }
    assert.deepEqual(seen, [{ content: '!!reactionroletest', args: [] }]);
    const inboxFile = path.join(root, 'queue', 'inbox', '8003.json');
    assert.equal(fs.existsSync(inboxFile), false);
  });
});
