#!/bin/bash
# Keeps the standalone bridge running. One supervisor per pilot dir (flock).
# Runs $BRIDGE_DIR/start.sh in the foreground and starts it again when it exits:
# after a crash, after the bridge exits 75 because its gateway went stale, or
# after the watchdog kills a hung process. Never restarts while STOP exists.
# Usage: BRIDGE_DIR=/home/box/discord-bridge/comms-bot supervise.sh
set -u
D="${BRIDGE_DIR:-/home/box/discord-bridge/comms-bot}"
mkdir -p "$D/logs"
MATCH="${BRIDGE_MATCH:-discord-bridge/standalone}"
LOG="$D/logs/supervisor.log"
PIDFILE="$D/logs/bridge.pid"
exec 9>"$D/logs/.supervisor.lock"
flock -n 9 || exit 0
say() { echo "$(date -Is) $*" >> "$LOG"; }
say "supervisor up pid=$$"
fast=0
while true; do
  if [ -f "$D/STOP" ]; then sleep 30; continue; fi
  # A bridge started by hand outside the supervisor: leave it alone and wait.
  if pgrep -f "$MATCH" >/dev/null 2>&1; then sleep 30; continue; fi
  # No bridge is running, so a leftover lock is stale (its pid may be reused after a reboot).
  rm -f "$D/queue/state/bridge.lock"
  started=$(date +%s)
  say "start"
  "$D/start.sh" >> "$D/logs/bridge.out" 2>&1 9>&- &
  child=$!
  echo "$child" > "$PIDFILE"
  wait "$child"
  code=$?
  rm -f "$PIDFILE"
  ran=$(( $(date +%s) - started ))
  say "exit code=$code ran=${ran}s"
  if [ "$ran" -ge 600 ]; then fast=0; else fast=$((fast + 1)); fi
  if [ "$code" -eq 75 ] && [ "$fast" -le 3 ]; then
    delay=2
  else
    delay=$(( 5 * (1 << (fast > 6 ? 6 : fast)) ))
    [ "$delay" -gt 300 ] && delay=300
  fi
  sleep "$delay"
done
