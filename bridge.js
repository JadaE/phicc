'use strict';

// Optional standalone entry. Phicc itself keeps using bot.js.
const { main } = require('./discord-bridge/standalone');

if (require.main === module) {
  main();
}

module.exports = { main };
