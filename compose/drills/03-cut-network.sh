#!/usr/bin/env bash
# Cut the daemon<->bb network mid-run and restore it. Short cut: the stream
# resumes from the last event id. Cut longer than MULTICA_BB_SILENCE_TIMEOUT:
# the attempt times out, Multica retries, and the retry reattaches.
source "$(dirname "$0")/lib.sh"
mock_defaults; mock_config '{"stepDelay":"2s","resultAfter":10}'
NET="$(dc ps -q daemon | xargs docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep bbnet)"
CID="$(dc ps -q daemon)"
cut() { # seconds
  log "cutting $NET for $1s mid-run"
  I="$(new_issue "drill: network cut ${1}s")"
  wait_bb_running "$I"
  docker network disconnect "$NET" "$CID"
  sleep "$1"
  docker network connect --alias daemon "$NET" "$CID"
  wait_settled "$I" 300
  check_invariants "$I" completed
}
cut "${CUT_SECONDS:-20}"
# Past MULTICA_BB_SILENCE_TIMEOUT (2m in compose): timeout -> retry -> reattach.
if [ "${LONG_DRILLS:-0}" = "1" ]; then cut 150; fi
mock_defaults
