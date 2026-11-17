#!/usr/bin/env bash
# A reply on the issue starts a new bb run that continues the SAME bb session.
source "$(dirname "$0")/lib.sh"
mock_defaults
log "reply on a finished issue"
I="$(new_issue "drill: reply continues the session")"
wait_settled "$I" 120
mc issue comment add "$I" --content "@bb one more thing: also update the changelog" >/dev/null
for _ in $(seq 60); do [ "$(runs_json "$I" | jq length)" -ge 2 ] && break; sleep 2; done
wait_settled "$I" 120
check_invariants "$I" completed
mock_state | jq -e --arg i "$I" '[.tasks[] | select(.issue==$i)] as $t
  | ($t|length)==2 and $t[1].resumedFrom == $t[0].sessionId' >/dev/null \
  || fail "$I: the reply did not resume the first run's bb session"
pass "$I: reply resumed bb session $(mock_state | jq -r --arg i "$I" '[.tasks[]|select(.issue==$i)][0].sessionId')"
