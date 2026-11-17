#!/usr/bin/env bash
# Kill the daemon mid-run, both gracefully (SIGTERM: rolling deploy) and hard
# (SIGKILL: crash). Multica re-queues (runtime_recovery / runtime_offline); the
# retry must REATTACH to the running bb task, never start a second one.
source "$(dirname "$0")/lib.sh"
mock_defaults; mock_config '{"stepDelay":"2s","resultAfter":10}'
for sig in TERM KILL; do
  log "SIG$sig: daemon dies mid-run"
  I="$(new_issue "drill: SIG$sig daemon mid-run")"
  wait_bb_running "$I"
  dc kill -s "SIG$sig" daemon >/dev/null
  sleep 3
  dc up -d --no-build daemon >/dev/null 2>&1
  wait_settled "$I" 240
  check_invariants "$I" completed
done
mock_defaults
