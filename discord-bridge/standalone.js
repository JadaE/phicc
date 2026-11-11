'use strict';

const { loadConfig, assertReady } = require('./src/config');
const { createBridgeClient } = require('./src/client');
const { attachToClient } = require('./src/bridge');

/**
 * Standalone process for a forked bridge. Does not register Phicc's !! commands.
 * Refuses to log in when the feature flag is off, placeholders remain, or the
 * token env var is empty. The token is never written to the log.
 */
function main(options = {}) {
  const loaded = options.config
    ? { config: options.config, localPath: options.localPath || null }
    : loadConfig(options);
  const config = loaded.config;
  if (!config.features.enabled) {
    console.log(JSON.stringify({ event: 'bridge_disabled' }));
    return { started: false, reason: 'disabled' };
  }
  try {
    assertReady(config, { localPath: loaded.localPath });
  } catch (err) {
    console.error(JSON.stringify({ event: 'bridge_refused', reason: 'config' }));
    if (require.main === module) process.exitCode = 1;
    return { started: false, reason: 'config' };
  }
  const tokenEnv = (config.discord && config.discord.tokenEnv) || 'DISCORD_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) {
    console.error(JSON.stringify({ event: 'missing_token_env', tokenEnv }));
    if (require.main === module) process.exitCode = 1;
    return { started: false, reason: 'missing_token' };
  }
  const discordLib = options.discord || require('discord.js');
  const client = createBridgeClient(discordLib, config);
  attachToClient(client, { config, localPath: loaded.localPath, autostart: true });
  const pending = client.login(token).catch(() => {
    console.error(JSON.stringify({ event: 'login_failed' }));
    if (require.main === module) process.exitCode = 1;
  });
  return { started: true, client, pending };
}

module.exports = { main };
