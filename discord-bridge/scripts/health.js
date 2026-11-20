#!/usr/bin/env node
'use strict';

// Watchdog helper. Prints one JSON line and exits 0 when the bridge heartbeat is
// healthy, 1 when it is stale or unhealthy. Reads only the heartbeat file.
// Usage: node health.js <heartbeat.json> [maxFileAgeSec=120] [maxPacketAgeSec=180]
const { checkHeartbeatFile } = require('../src/liveness');

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify({ ok: false, reason: 'usage' }));
  process.exit(2);
}
const maxAgeMs = (Number(process.argv[3]) || 120) * 1000;
const maxPacketAgeMs = (Number(process.argv[4]) || 180) * 1000;
const result = checkHeartbeatFile(file, { maxAgeMs, maxPacketAgeMs });
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
