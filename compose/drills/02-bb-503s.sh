#!/usr/bin/env bash
# bb answers 503 to everything for 60s. The PUT retries with backoff and the
# stream reconnects; work assigned during the outage still runs exactly once.
source "$(dirname "$0")/lib.sh"
mock_defaults
log "bb returns 503 for 60s; one issue assigned before, one during the outage"
A="$(new_issue "drill: 503 storm (in flight)")"
wait_bb_running "$A"
mock_config '{"failFor":"60s"}'
B="$(new_issue "drill: 503 storm (assigned during outage)")"
wait_settled "$A" 180; wait_settled "$B" 180
check_invariants "$A" completed
check_invariants "$B" completed
mock_defaults
