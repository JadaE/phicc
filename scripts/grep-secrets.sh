#!/bin/sh
# Grep a log for token-shaped strings or for secrets passed as files.
# Prints a result code only. Never prints a matching line or a secret.
# Usage: grep-secrets.sh LOGFILE [SECRETFILE...]
set -eu
if [ "$#" -lt 1 ]; then
  printf '%s\n' '{"event":"log_grep","result":"usage"}'
  exit 2
fi
log=$1
shift
if [ ! -f "$log" ]; then
  printf '%s\n' '{"event":"log_grep","result":"missing"}'
  exit 2
fi
if grep -E -q '[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}' "$log"; then
  printf '%s\n' '{"event":"log_grep","result":"secret-hit"}'
  exit 1
fi
for secret_file in "$@"; do
  if [ ! -f "$secret_file" ]; then
    printf '%s\n' '{"event":"log_grep","result":"missing"}'
    exit 2
  fi
  # Fixed-string match. The secret is not written to stdout or stderr.
  if grep -F -q -f "$secret_file" "$log"; then
    printf '%s\n' '{"event":"log_grep","result":"secret-hit"}'
    exit 1
  fi
done
printf '%s\n' '{"event":"log_grep","result":"clean"}'
exit 0
