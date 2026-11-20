'use strict';

const { main } = require('../discord-bridge/post-reply');

if (require.main === module) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main };
