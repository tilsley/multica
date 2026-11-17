#!/usr/bin/env bash
# Cancel from the CLI (same API the UI calls). The cancel must reach bb.
source "$(dirname "$0")/lib.sh"
mock_defaults; mock_config '{"stepDelay":"3s","resultAfter":20}'
log "cancel a running task"
I="$(new_issue "drill: cancel")"
wait_bb_running "$I"
TASK="$(runs_json "$I" | jq -r '[.[] | select(.status=="running")][0].id')"
mc issue cancel-task "$TASK" >/dev/null
wait_settled "$I" 60
for _ in $(seq 20); do  # cancel is async on the daemon side
  mock_state | jq -e --arg i "$I" '[.tasks[] | select(.issue==$i)][0].status == "cancelled"' >/dev/null && break
  sleep 1
done
check_invariants "$I" cancelled
mock_defaults
