'use strict';

const fs = require('fs');
const path = require('path');
const { redactValue, hashId } = require('./redact');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(options = {}) {
  const levelName = options.level || 'info';
  const min = LEVELS[levelName] == null ? LEVELS.info : LEVELS[levelName];
  const logBodies = Boolean(options.logBodies);
  const dir = options.dir || null;
  const stream = options.stream || null;

  function write(level, entry) {
    if (LEVELS[level] < min) return;
    const payload = redactValue({ ...entry });
    if (!logBodies) {
      delete payload.text;
      delete payload.content;
      delete payload.body;
      delete payload.bodyText;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      ...payload,
    });
    if (stream) {
      stream.write(`${line}\n`);
      return;
    }
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch (err) { /* best effort */ }
    const file = path.join(dir, 'bridge.log');
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  }

  return {
    debug(entry) { write('debug', entry); },
    info(entry) { write('info', entry); },
    warn(entry) { write('warn', entry); },
    error(entry) { write('error', entry); },
    audit(reason, message) {
      write('info', {
        event: 'audit',
        reason,
        authorHash: message && message.author ? hashId(message.author.id) : undefined,
        guildId: message ? (message.guildId || (message.guild && message.guild.id) || null) : null,
        channelId: message ? (message.channelId || (message.channel && message.channel.id) || null) : null,
        messageId: message ? message.id : undefined,
      });
    },
  };
}

module.exports = { createLogger, LEVELS };
