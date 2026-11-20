#!/bin/sh
# Documented image check. Run after a build, before the image is used:
#   scripts/check-image-history.sh discord-bridge:nas
# `docker history --no-trunc` must not show a secret assignment. The Dockerfile
# pins the base image by digest and does not COPY config.local.json, reply.env,
# or any secret file. Compose passes secrets as files, not environment values.
# When docker is not installed, set ALLOW_NO_DOCKER=1 to exit 0 (CI does this).
set -eu
image=${1:-discord-bridge:nas}
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' '{"event":"docker_history","result":"docker-not-available"}'
  if [ "${ALLOW_NO_DOCKER:-}" = "1" ]; then
    exit 0
  fi
  exit 3
fi
history=$(docker history --no-trunc --format '{{.CreatedBy}}' "$image" 2>/dev/null || true)
if [ -z "$history" ]; then
  printf '%s\n' '{"event":"docker_history","result":"no-image"}'
  if [ "${ALLOW_NO_DOCKER:-}" = "1" ]; then
    exit 0
  fi
  exit 3
fi
if printf '%s\n' "$history" | grep -E -q 'DISCORD_TOKEN=.+|COMMS_WEBHOOK_KEY=.+|COMMS_WEBHOOK_URL=https://.+|QUEUE_HMAC_KEY=.+|ENVELOPE_HMAC_KEY=.+|OUTBOX_HMAC_KEY=.+'; then
  printf '%s\n' '{"event":"docker_history","result":"secret-hit"}'
  exit 1
fi
printf '%s\n' '{"event":"docker_history","result":"clean"}'
exit 0
