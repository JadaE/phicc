#!/bin/bash
# RETIRED marker. One check shared by the box supervisor scripts.
# A present file means this machine must not start the gateway.

refuse_if_retired() {
  dir=$1
  marker="${DBR_RETIRED_FILE:-$dir/RETIRED}"
  if [ -f "$marker" ]; then
    printf '%s\n' '{"event":"retired","action":"refuse"}' >&2
    exit 78
  fi
}
