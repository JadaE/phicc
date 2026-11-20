#!/bin/bash
# One check, run every 60 s by watchdog-loop.sh. Makes sure the supervisor is up,
# and kills the bridge when its heartbeat file says the gateway is stale, so the
# supervisor reconnects it. "Process running + a TCP socket" is not healthy on
# this box: every socket goes to the local egress proxy and can look open while
# the real Discord connection is gone. Never acts while STOP exists.
set -u
D="${BRIDGE_DIR:-/home/box/discord-bridge/comms-bot}"
SRC="${BRIDGE_SRC:-/workspace/phicc/discord-bridge}"
# shellcheck disable=SC1091
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/lib/retired.sh"
refuse_if_retired "$D"
[ -f "$D/STOP" ] && exit 0
mkdir -p "$D/logs"
LOG="$D/logs/watchdog.log"
say() { echo "$(date -Is) $*" >> "$LOG"; }
if flock -n "$D/logs/.supervisor.lock" true 2>/dev/null; then
  # Nobody holds the supervisor lock, so no supervisor is running.
  say "supervisor not running, starting it"
  BRIDGE_DIR="$D" setsid nohup "$SRC/scripts/supervise.sh" >/dev/null 2>&1 < /dev/null &
  exit 0
fi
P=$(cat "$D/logs/bridge.pid" 2>/dev/null)
kill -0 "$P" 2>/dev/null || P=$(pgrep -f "${BRIDGE_MATCH:-discord-bridge/standalone}" | head -1)
[ -z "$P" ] && exit 0   # between restarts; the supervisor handles it
# Give a new process time to connect before judging it.
age=$(ps -o etimes= -p "$P" 2>/dev/null | tr -d ' ')
[ -z "$age" ] || [ "$age" -lt "${BRIDGE_MIN_AGE:-120}" ] && exit 0
if out=$(node "$SRC/scripts/health.js" "$D/logs/heartbeat.json" "${BRIDGE_MAX_FILE_AGE:-120}" "${BRIDGE_MAX_PACKET_AGE:-180}" 2>/dev/null); then exit 0; fi
say "stale heartbeat, killing pid=$P: $out"
kill "$P" 2>/dev/null
sleep 10
kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
exit 0
