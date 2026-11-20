'use strict';

const { loadConfig, assertReady } = require('./src/config');
const { createBridgeClient } = require('./src/client');
const { attachToClient } = require('./src/bridge');
const { secretValue } = require('./src/secrets');
const { retiredMarker } = require('./src/retired');

/**
 * Standalone process for a forked bridge. Does not register Phicc's !! commands.
 * Refuses to log in when the feature flag is off, placeholders remain, or the
 * token env var is empty. The token is never written to the log.
 */
function main(options = {}) {
  const env = options.env || process.env;
  if (retiredMarker(env)) {
    console.error(JSON.stringify({ event: 'retired', action: 'refuse' }));
    if (require.main === module) process.exitCode = 78;
    return { started: false, reason: 'retired' };
  }
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
  let token = '';
  try {
    token = secretValue(process.env, tokenEnv);
  } catch (err) {
    token = '';
  }
  if (!token) {
    console.error(JSON.stringify({ event: 'missing_token_env', tokenEnv }));
    if (require.main === module) process.exitCode = 1;
    return { started: false, reason: 'missing_token' };
  }
  const discordLib = options.discord || require('discord.js');
  const client = createBridgeClient(discordLib, config);
  // Liveness: when the gateway goes stale (zombie socket, stuck reconnect, the box
  // was asleep), exit with code 75 so the supervisor starts a fresh connection.
  // Backfill: after READY or RESUME, pick up mentions sent while disconnected.
  const exitFn = options.exit || ((code) => process.exit(code));
  let bridge = null;
  let exiting = false;
  const onStale = () => {
    if (exiting) return;
    exiting = true;
    try { if (bridge && bridge.detach) bridge.detach(); } catch (err) { /* exiting anyway */ }
    try { client.destroy(); } catch (err) { /* exiting anyway */ }
    setTimeout(() => exitFn(75), options.exitDelayMs == null ? 500 : options.exitDelayMs);
  };
  bridge = attachToClient(client, {
    config,
    localPath: loaded.localPath,
    autostart: true,
    backfill: options.backfill !== false,
    liveness: options.liveness === false ? null : { ...(options.liveness || {}), onStale },
  });
  const pending = client.login(token).catch(() => {
    console.error(JSON.stringify({ event: 'login_failed' }));
    if (require.main === module) process.exitCode = 1;
  });
  return { started: true, client, pending, bridge, onStale };
}

module.exports = { main };
