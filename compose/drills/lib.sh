#!/usr/bin/env bash
# Shared helpers for the compose failure drills. Source, don't execute.
# Needs on the host: docker compose, curl, jq.
set -euo pipefail
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOCK="${MOCK_BB_URL:-http://127.0.0.1:${MOCK_BB_PORT:-8787}}"
# Honors COMPOSE_FILE (e.g. docker-compose.yml:docker-compose.bb.yml for real bb).
dc() { (cd "$COMPOSE_DIR" && docker compose "$@"); }
mc() { dc exec -T daemon multica "$@"; }
log() { printf '\033[1;34m[%s] %s\033[0m\n' "$(date +%T)" "$*"; }
fail() { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '\033[1;32mPASS: %s\033[0m\n' "$*"; }

mock_config() { curl -sf -X POST "$MOCK/admin/config" -d "$1" >/dev/null; }
mock_state() { curl -sf "$MOCK/admin/state"; }
# Restore the default switches (keeps run history, unlike /admin/reset).
mock_defaults() { mock_config '{"failFirst":0,"failFor":"0s","acceptThenDrop":0,"dropAfter":0,"silentFor":"0s","stepDelay":"1s","resultAfter":8,"heartbeatEvery":"2s","resultStatus":"succeeded","duplicatePut":false}'; }

runs_json() { mc issue runs "$1" --output json | jq '(if type=="array" then . else .runs end) // []'; }

new_issue() { # title -> identifier; assigning to the bb agent queues a task
  mc issue create --title "$1 [$(date +%H%M%S)-$RANDOM]" --description "${2:-compose drill}" --assignee bb --output json | jq -r .identifier
}

# Wait until bb has a running task for the issue (it has really started work).
wait_bb_running() { # issue timeout
  for _ in $(seq "${2:-60}"); do
    mock_state | jq -e --arg i "$1" '[.tasks[] | select(.issue==$i and .status=="running" and .eventCount>1)] | length > 0' >/dev/null && return 0
    sleep 1
  done
  fail "$1: bb never started a run"
}

# Wait until the issue is quiet: every Multica run terminal AND no bb run for it
# still running, seen on two polls 3s apart. One poll is not enough: when the
# server fails an attempt (runtime_recovery) it can insert the retry a moment
# later, and a poll in that gap sees "all terminal" while work is still live.
settled_once() { # issue
  runs_json "$1" | jq -e 'length > 0 and all(.[]; .status|IN("completed","failed","cancelled"))' >/dev/null \
    && mock_state | jq -e --arg i "$1" 'all(.tasks[] | select(.issue==$i); .status != "running")' >/dev/null
}
wait_settled() { # issue timeout-in-polls
  for _ in $(seq "${2:-180}"); do
    if settled_once "$1"; then
      sleep 3
      settled_once "$1" && return 0
    fi
    sleep 2
  done
  runs_json "$1" | jq -c '.[] | {id, status, attempt, parent_task_id, failure_reason}' >&2
  fail "$1: runs did not settle"
}

# The drill invariants, checked per retry lineage (a root task plus its
# auto-retry children, linked by parent_task_id):
#   1. exactly one bb run per lineage (no duplicate runs across retries),
#   2. no task lost: every lineage ends in a terminal state,
#   3. board matches bb: the lineage's final status equals the bb run's.
check_invariants() { # issue [expected-final-status]
  local issue="$1" want="${2:-}" runs state report
  runs="$(runs_json "$issue")"
  state="$(mock_state)"
  report="$(jq -n --argjson runs "$runs" --argjson st "$state" --arg issue "$issue" --arg want "$want" '
    def leaf($id): ([$runs[] | select(.parent_task_id == $id)] | first) as $c
                   | if $c == null then $id else leaf($c.id) end;
    def lineage($id): [$id] + ([$runs[] | select(.parent_task_id == $id) | lineage(.id)] | add // []);
    def bbmap: {completed:"succeeded", failed:"failed", cancelled:"cancelled"};
    [$runs[] | select(.parent_task_id == null)] as $roots
    | ($st.tasks | map(select(.issue == $issue))) as $bbruns
    | [ $roots[] as $r
        | lineage($r.id) as $ids
        | leaf($r.id) as $leafid
        | ($runs[] | select(.id == $leafid)) as $leaf
        | [$bbruns[] | select(.id as $b | ($ids | index($b)) or (.aliases | any(. as $a | $ids | index($a))))] as $mine
        | {root: $r.id[0:13], attempts: ($ids|length), final: $leaf.status, reason: $leaf.failure_reason,
           bb_runs: ($mine|length), bb_status: ($mine[0].status // null),
           ok_one_run: (($mine|length) == 1),
           ok_terminal: ($leaf.status | IN("completed","failed","cancelled")),
           ok_match: (($mine|length)==1 and (bbmap[$leaf.status] == $mine[0].status)),
           ok_want: ($want == "" or $leaf.status == $want)} ]
    | {lineages: ., bb_runs_for_issue: ($bbruns|length), roots: ($roots|length),
       ok: (all(.[]; .ok_one_run and .ok_terminal and .ok_match and .ok_want) and ($bbruns|length) == ($roots|length))}')"
  echo "$report" | jq -c '.lineages[]'
  echo "$report" | jq -e .ok >/dev/null || { echo "$report" | jq . >&2; fail "$issue: invariants violated"; }
  pass "$issue: one bb run per lineage, nothing lost, board matches bb"
}
