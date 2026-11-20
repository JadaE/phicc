'use strict';

const { loadConfig, assertReady, expandHome, defaultConfig, merge, clampConfig } = require('./src/config');
const { evaluate, RateLimiter } = require('./src/policy');
const { FileQueue } = require('./src/queue');
const { WakeHandoff, postWebhook, parseHttpsWebhook } = require('./src/wake');
const { chunkReply, TRUNCATION_NOTE, MAX_CHUNK_LEN, MAX_CHUNKS } = require('./src/chunk');
const { redact, redactSecrets, hashId } = require('./src/redact');
const { createLogger, errorFields } = require('./src/log');
const { Bridge, attachToClient, allowedMentions } = require('./src/bridge');
const { signRecord, verifyRecord } = require('./src/sign');
const { secretValue, resolveSecrets } = require('./src/secrets');
const { sanitizeWakeItem } = require('./src/wake');
const {
  EnvelopeIngress,
  envelopeConfigured,
  selectKeys,
  verifyEnvelope,
  NonceStore,
  PartStore,
} = require('./src/envelope');
const {
  planStart,
  noteExit,
  delayMs,
  superviseOnce,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
} = require('./src/restart');
const { postReply, splitReply, main: postReplyMain } = require('./post-reply');
const { createBridgeClient, resolveIntentBits, REQUIRED_INTENTS } = require('./src/client');
const { permissionInteger, PERMISSIONS, PRESETS } = require('./src/permissions');
const { nextBackoffMs, noteIdentify, trackGateway } = require('./src/reconnect');
const { GatewayMonitor, checkHeartbeatFile } = require('./src/liveness');
const { Backfill } = require('./src/backfill');

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
  sanitizeWakeItem,
  secretValue,
  resolveSecrets,
  EnvelopeIngress,
  envelopeConfigured,
  selectKeys,
  verifyEnvelope,
  NonceStore,
  PartStore,
  planStart,
  noteExit,
  delayMs,
  superviseOnce,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  postReply,
  splitReply,
  postReplyMain,
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
  allowedMentions,
  createBridgeClient,
  resolveIntentBits,
  REQUIRED_INTENTS,
  permissionInteger,
  PERMISSIONS,
  PRESETS,
  nextBackoffMs,
  noteIdentify,
  trackGateway,
  GatewayMonitor,
  checkHeartbeatFile,
  Backfill,
};
