'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PRESETS, permissionInteger, PERMISSIONS } = require('../discord-bridge');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('NAS package', () => {
  it('pins the image, drops privileges, and keeps secrets out of the image env', () => {
    const dockerfile = read('deploy/nas/Dockerfile');
    assert.match(dockerfile, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
    assert.match(dockerfile, /USER 10001:10001/);
    assert.match(dockerfile, /discord-bridge\/scripts\/health\.js/);
    assert.match(dockerfile, /deploy\/nas\/entrypoint\.js/);
    assert.equal(/ENV[^\n]*(TOKEN|HMAC|WEBHOOK_URL|WEBHOOK_KEY)=/i.test(dockerfile), false);
    assert.equal(dockerfile.includes('config.local.json'), false);
    assert.equal(dockerfile.includes('reply.env'), false);

    const ignore = read('.dockerignore');
    for (const name of ['config.local.json', 'reply.env', '.env']) {
      assert.match(ignore, new RegExp(name));
    }
  });

  it('compose has no ports and mounts config read-only with secret files', () => {
    const compose = read('deploy/nas/compose.yaml');
    assert.equal(/^\s*ports\s*:/m.test(compose), false);
    assert.match(compose, /read_only:\s*true/);
    assert.match(compose, /tmpfs:/);
    assert.match(compose, /\/tmp/);
    assert.match(compose, /user:\s*"10001:10001"/);
    assert.match(compose, /cap_drop:\s*\n\s*-\s*ALL/);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(compose, /mem_limit:\s*256m/);
    assert.match(compose, /pids_limit:\s*128/);
    assert.match(compose, /target:\s*\/app\/config\.local\.json/);
    assert.match(compose, /read_only:\s*true/);
    for (const name of ['discord_token', 'comms_webhook_url', 'comms_webhook_key', 'queue_hmac', 'envelope_hmac']) {
      assert.match(compose, new RegExp(name));
    }
    assert.match(compose, /DISCORD_TOKEN_FILE:/);
    assert.equal(/DISCORD_TOKEN:\s*\S+/.test(compose), false);
    assert.match(compose, /DBR_WAKE_CARRYRECORD:\s*"true"/);
    assert.match(compose, /DBR_BACKFILL_ENABLED:\s*"true"/);
    assert.match(compose, /DBR_WAKE_ALLOWEDHOSTS:\s*"YOUR_WEBHOOK_HOST"/);
    assert.match(compose, /ENVELOPE_HMAC_KEY_PREVIOUS_FILE/);
    const envExample = read('deploy/nas/env.example');
    assert.match(envExample, /DBR_WAKE_ALLOWEDHOSTS=YOUR_WEBHOOK_HOST/);
    assert.match(envExample, /ENVELOPE_HMAC_KEY_PREVIOUS_FILE/);
    assert.equal(envExample.includes('discord.com/api/webhooks/'), false);
  });

  it('ships the compose wrapper and the hardened systemd alternative', () => {
    const wrap = read('deploy/nas/discord-bridge.service');
    const native = read('deploy/nas/discord-bridge.native.service');
    assert.match(wrap, /docker compose/);
    assert.match(wrap, /WantedBy=multi-user\.target/);
    assert.match(native, /User=dbridge/);
    assert.match(native, /Restart=always/);
    assert.match(native, /RestartSec=5/);
    assert.match(native, /StartLimitIntervalSec=0/);
    assert.match(native, /NoNewPrivileges=yes/);
    assert.match(native, /ProtectSystem=strict/);
    assert.match(native, /ProtectHome=yes/);
    assert.match(native, /PrivateTmp=yes/);
    assert.match(native, /PrivateDevices=yes/);
    assert.match(native, /ProtectKernelTunables=yes/);
    assert.match(native, /ProtectKernelModules=yes/);
    assert.match(native, /ProtectKernelLogs=yes/);
    assert.match(native, /ProtectControlGroups=yes/);
    assert.match(native, /RestrictNamespaces=yes/);
    assert.match(native, /RestrictSUIDSGID=yes/);
    assert.match(native, /LockPersonality=yes/);
    assert.match(native, /SystemCallFilter=@system-service/);
    assert.match(native, /UMask=0077/);
    assert.match(native, /ReadWritePaths=\/srv\/ssd1\/discord-bridge\/queue \/srv\/ssd1\/discord-bridge\/state \/srv\/ssd1\/discord-bridge\/logs/);
    assert.equal(/ReadWritePaths=\/srv\/ssd1\/discord-bridge\s/.test(native), false);
    assert.match(native, /ENVELOPE_HMAC_KEY_PREVIOUS_FILE/);
    assert.match(native, /DBR_WAKE_ALLOWEDHOSTS=YOUR_WEBHOOK_HOST/);
    assert.match(native, /CapabilityBoundingSet=/);
    const install = read('deploy/nas/install.sh');
    assert.match(install, /chown -R root:root "\$ROOT\/app" "\$ROOT\/secrets"/);
    assert.match(install, /chmod 700 "\$ROOT\/secrets"/);
    assert.match(native, /RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX/);
    assert.match(native, /LoadCredential=discord_token:/);
    assert.match(native, /WantedBy=multi-user\.target/);
    assert.equal(/Environment=DISCORD_TOKEN=/.test(native), false);
    const runbook = read('RUNBOOK.md');
    assert.match(runbook, /## NAS package/);
    assert.match(runbook, /Cutover/);
    assert.match(runbook, /Rollback/);
    assert.match(runbook, /docker history --no-trunc/);
    assert.equal(/does not read channel history/.test(runbook), false);
  });

  it('keeps Administrator off the outbox overwrite', () => {
    assert.equal(PERMISSIONS.MANAGE_MESSAGES, 8192);
    assert.equal(PRESETS.outboxChannel, 74752);
    assert.equal(PRESETS.base, 68608);
    assert.equal(PRESETS.embedsAndReactions, 85056);
    assert.equal(permissionInteger(['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'MANAGE_MESSAGES']), 74752);
    assert.throws(() => permissionInteger(['MANAGE_MESSAGES', 'ADMINISTRATOR']), /never allowed/);
  });
});
