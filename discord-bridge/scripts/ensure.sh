#!/bin/bash
# Idempotent. Starts the watchdog loop (which starts the supervisor) if it is not
# already running. Safe to call from any agent turn or routine, e.g. after the box
# restarts: nothing on this box starts it at boot.
set -u
D="${BRIDGE_DIR:-/home/box/discord-bridge/comms-bot}"
SRC="${BRIDGE_SRC:-/workspace/phicc/discord-bridge}"
mkdir -p "$D/logs"
if flock -n "$D/logs/.watchdog-loop.lock" true 2>/dev/null; then
  BRIDGE_DIR="$D" BRIDGE_SRC="$SRC" setsid nohup flock -n "$D/logs/.watchdog-loop.lock" \
    bash -c 'while true; do "$0/scripts/watchdog.sh"; sleep 60; done' "$SRC" >/dev/null 2>&1 < /dev/null &
  echo "watchdog loop started"
else
  echo "watchdog loop already running"
fi
