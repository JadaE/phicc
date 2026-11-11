'use strict';

const { loadConfig, assertReady, expandHome, defaultConfig, merge, clampConfig } = require('./src/config');
const { evaluate, RateLimiter } = require('./src/policy');
const { FileQueue } = require('./src/queue');
const { WakeHandoff, postWebhook, parseHttpsWebhook } = require('./src/wake');
const { chunkReply, TRUNCATION_NOTE, MAX_CHUNK_LEN, MAX_CHUNKS } = require('./src/chunk');
const { redact, redactSecrets, hashId } = require('./src/redact');
const { createLogger, errorFields } = require('./src/log');
const { Bridge, attachToClient, ALLOWED_MENTIONS } = require('./src/bridge');
const { signRecord, verifyRecord } = require('./src/sign');
const { createBridgeClient, resolveIntentBits, REQUIRED_INTENTS } = require('./src/client');
const { permissionInteger, PERMISSIONS, PRESETS } = require('./src/permissions');
const { nextBackoffMs, noteIdentify, trackGateway } = require('./src/reconnect');

module.exports = {
  loadConfig,
  assertReady,
  expandHome,
  defaultConfig,
  merge,
  clampConfig,
  evaluate,
  RateLimiter,
  FileQueue,
  WakeHandoff,
  postWebhook,
  parseHttpsWebhook,
  chunkReply,
  TRUNCATION_NOTE,
  MAX_CHUNK_LEN,
  MAX_CHUNKS,
  redact,
  redactSecrets,
  hashId,
  createLogger,
  errorFields,
  signRecord,
  verifyRecord,
  Bridge,
  attachToClient,
  ALLOWED_MENTIONS,
  createBridgeClient,
  resolveIntentBits,
  REQUIRED_INTENTS,
  permissionInteger,
  PERMISSIONS,
  PRESETS,
  nextBackoffMs,
  noteIdentify,
  trackGateway,
};
