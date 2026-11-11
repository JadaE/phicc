'use strict';

/**
 * Discord permission bitfield values from the permissions page.
 * ADMINISTRATOR (8) bypasses channel overwrites and is never granted.
 */
const PERMISSIONS = Object.freeze({
  ADD_REACTIONS: 1 << 6,
  ADMINISTRATOR: 1 << 3,
  VIEW_CHANNEL: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  EMBED_LINKS: 1 << 14,
  READ_MESSAGE_HISTORY: 1 << 16,
  SEND_MESSAGES_IN_THREADS: 2 ** 38,
});

const BASE_NAMES = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'];
const REACTION_NAMES = BASE_NAMES.concat(['ADD_REACTIONS']);
const EMBED_REACTION_NAMES = BASE_NAMES.concat(['EMBED_LINKS', 'ADD_REACTIONS']);
const THREAD_NAMES = EMBED_REACTION_NAMES.concat(['SEND_MESSAGES_IN_THREADS']);

function permissionInteger(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('permissionInteger requires a list of permission names');
  }
  // Discord permission bits past 2^31 do not fit in JavaScript's 32-bit
  // bitwise operators, so unique bits are added. They do not overlap.
  const seen = new Set();
  let bits = 0;
  for (const raw of names) {
    const name = String(raw).trim().toUpperCase();
    if (name === 'ADMINISTRATOR') {
      throw new Error('ADMINISTRATOR is never allowed');
    }
    if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, name)) {
      throw new Error(`unknown permission: ${name}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    bits += PERMISSIONS[name];
  }
  return bits;
}

const PRESETS = Object.freeze({
  base: permissionInteger(BASE_NAMES),
  reactions: permissionInteger(REACTION_NAMES),
  embedsAndReactions: permissionInteger(EMBED_REACTION_NAMES),
  withThreads: permissionInteger(THREAD_NAMES),
});

module.exports = {
  PERMISSIONS,
  PRESETS,
  BASE_NAMES,
  REACTION_NAMES,
  EMBED_REACTION_NAMES,
  THREAD_NAMES,
  permissionInteger,
};
