'use strict';

delete process.env.PHICC_BRIDGE_ENABLED;

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bot, onMessageCreate, prefix, Discord } = require('../bot');

function call(content, author) {
  return {
    content,
    author: author || { id: '333', bot: false },
  };
}

describe('Phicc with the bridge flag off', () => {
  it('does not attach a bridge or a second message listener', () => {
    assert.equal(bot.phiccBridge, undefined);
    assert.equal(prefix, '!!');
    assert.equal(bot.listenerCount('messageCreate'), 1);
  });

  it('preserves the original intents, commands, and login line', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    assert.match(source, /intents: \["GUILDS", "GUILD_MESSAGES", "GUILD_MESSAGE_REACTIONS", "GUILD_EMOJIS_AND_STICKERS"\]/);
    assert.match(source, /bot\.login\(process\.env\.DISCORD_TOKEN\)/);
    assert.match(source, /command === 'reactionroletest'/);
    assert.match(source, /command === 'rulereader'/);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'meeseek');
    assert.equal(pkg.dependencies['discord.js'], '^13.6.0');
    assert.equal(pkg.dependencies['discord.io'], '^2.5.3');
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'LICENSE')), false);
  });

  it('dispatches !!rulereader and !!reactionroletest the same way', () => {
    const seen = [];
    const originals = new Map();
    for (const name of ['rulereader', 'reactionroletest']) {
      const command = bot.commands.get(name);
      originals.set(name, command.execute);
      command.execute = (message, args, discord, client) => {
        seen.push({ name, message, args, discord, client });
      };
    }
    try {
      onMessageCreate(call('!!rulereader'));
      onMessageCreate(call('!!reactionroletest extra'));
      onMessageCreate(call('!!rulereader', { id: '1', bot: true }));
      onMessageCreate(call('hello'));
      onMessageCreate(call('<@444> hello'));
    } finally {
      for (const [name, execute] of originals) bot.commands.get(name).execute = execute;
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0].name, 'rulereader');
    assert.deepEqual(seen[0].args, []);
    assert.equal(seen[0].discord, Discord);
    assert.equal(seen[0].client, bot);
    assert.equal(seen[1].name, 'reactionroletest');
    assert.deepEqual(seen[1].args, ['extra']);
  });

  it('logs unknown !! commands and does not throw', () => {
    const original = console.log;
    const lines = [];
    console.log = (line) => lines.push(line);
    try {
      onMessageCreate(call('!!nope'));
    } finally {
      console.log = original;
    }
    assert.deepEqual(lines, ['nope']);
  });
});
