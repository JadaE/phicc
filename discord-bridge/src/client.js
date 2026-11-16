'use strict';

/**
 * Gateway intents. Guilds = 1, GuildMessages = 512, together 513.
 * MESSAGE_CONTENT is 32768 and is privileged. This bridge does not request it:
 * Discord still delivers content for messages that mention the bot.
 */
const INTENT_BITS = Object.freeze({
  Guilds: 1,
  GUILDS: 1,
  GuildMessages: 512,
  GUILD_MESSAGES: 512,
});

const REQUIRED_INTENTS = 513;

function resolveIntentBits(intents) {
  if (intents == null) return REQUIRED_INTENTS;
  if (typeof intents === 'number') {
    if (intents !== REQUIRED_INTENTS) {
      throw new Error('bridge intents must be exactly Guilds + GuildMessages (513)');
    }
    return REQUIRED_INTENTS;
  }
  if (!Array.isArray(intents) || intents.length === 0) {
    throw new Error('bridge intents must be exactly Guilds + GuildMessages (513)');
  }
  let bits = 0;
  for (const name of intents) {
    if (!Object.prototype.hasOwnProperty.call(INTENT_BITS, name)) {
      throw new Error(`disallowed intent: ${name}`);
    }
    bits |= INTENT_BITS[name];
  }
  if (bits !== REQUIRED_INTENTS) {
    throw new Error('bridge intents must be exactly Guilds + GuildMessages (513)');
  }
  return bits;
}

function createBridgeClient(discordLib, config) {
  const Discord = discordLib || require('discord.js');
  const bits = resolveIntentBits(config && config.discord && config.discord.intents);
  return new Discord.Client({ intents: bits });
}

module.exports = {
  INTENT_BITS,
  REQUIRED_INTENTS,
  resolveIntentBits,
  createBridgeClient,
};
