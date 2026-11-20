'use strict';

const fs = require('fs');
const path = require('path');

function retiredPath(env = process.env) {
  if (env.DBR_RETIRED_FILE) return env.DBR_RETIRED_FILE;
  const dir = env.BRIDGE_DIR || '/home/box/discord-bridge/comms-bot';
  return path.join(dir, 'RETIRED');
}

function retiredMarker(env = process.env) {
  const file = retiredPath(env);
  return file && fs.existsSync(file) ? file : null;
}

module.exports = { retiredPath, retiredMarker };
