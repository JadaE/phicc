'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultConfig, merge } = require('../discord-bridge');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function enabledConfig(overrides) {
  const base = defaultConfig();
  base.features.enabled = true;
  base.discord.applicationId = '999';
  base.discord.botUserId = '444';
  base.discord.guildIds = ['111'];
  base.discord.channelIds = ['222'];
  base.discord.allowedUserIds = ['333'];
  base.discord.allowedRoleIds = ['555'];
  base.features.killSwitchFile = path.join(os.tmpdir(), 'phicc-bridge-not-created-STOP');
  return merge(base, overrides || {});
}

function fakeMessage(overrides = {}) {
  const botId = overrides.botId || '444';
  const userId = overrides.userId || '333';
  const mentioned = overrides.mention !== false;
  const users = new Map();
  if (mentioned) users.set(botId, { id: botId });
  for (const id of overrides.extraMentions || []) users.set(id, { id });
  const channelId = overrides.channelId === undefined ? '222' : overrides.channelId;
  return {
    id: overrides.id || '1001',
    content: overrides.content != null ? overrides.content : `<@${botId}> hello`,
    author: {
      id: userId,
      bot: Boolean(overrides.bot),
      username: overrides.username || 'jada',
    },
    member: overrides.member === null ? null : {
      displayName: overrides.displayName || 'Mina',
      roles: {
        cache: {
          has(id) { return (overrides.roles || []).includes(id); },
        },
      },
    },
    guildId: overrides.guildId === undefined ? '111' : overrides.guildId,
    channelId,
    channel: overrides.channel || {
      id: channelId,
      parentId: overrides.parentId || null,
      isThread: () => Boolean(overrides.thread),
    },
    webhookId: overrides.webhookId || null,
    createdTimestamp: overrides.createdTimestamp || 1700000000000,
    mentions: {
      everyone: Boolean(overrides.everyone),
      users: { has: (id) => users.has(id) },
      roles: { has: (id) => (overrides.mentionedRoles || []).includes(id) },
    },
    reply: overrides.reply || (async () => ({})),
    react: overrides.react || (async () => ({})),
    reactions: overrides.reactions,
  };
}

function memoryLogger() {
  const entries = [];
  const write = (level) => (entry) => entries.push({ level, ...entry });
  return {
    entries,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    audit(reason, message) {
      entries.push({
        level: 'info',
        event: 'audit',
        reason,
        messageId: message && message.id,
      });
    },
  };
}

module.exports = {
  tempDir,
  rmrf,
  enabledConfig,
  fakeMessage,
  memoryLogger,
};
