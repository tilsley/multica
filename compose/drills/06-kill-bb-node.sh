#!/usr/bin/env bash
# Real bb only (docker-compose.bb.yml): SIGKILL a celld node mid-run. Its cells
# move to the surviving node (celld ownership + epoch fencing), the run resumes
# from its durable state, and Multica sees one run with a gap-free log.
source "$(dirname "$0")/lib.sh"
if ! dc config --services | grep -qx bb-1; then
  log "skipped: no bb fleet (set COMPOSE_FILE=docker-compose.yml:docker-compose.bb.yml)"
  exit 0
fi
mock_defaults; mock_config '{"stepDelay":"1s","resultAfter":15}'
# Each node in turn, so the cell's owner dies in at least one round. bb-0 is
# also the node the daemon talks to: while it is down the daemon retries and
# reconnects (MULTICA_BB_SILENCE_TIMEOUT bounds the attempt).
for node in bb-1 bb-0; do
  log "SIGKILL $node mid-run"
  I="$(new_issue "drill: $node crash")"
  wait_bb_running "$I"
  dc kill -s SIGKILL "$node" >/dev/null 2>&1
  sleep 15
  dc up -d --no-build "$node" >/dev/null 2>&1
  wait_settled "$I" 300
  check_invariants "$I" completed
done
mock_defaults
