#!/usr/bin/env bash
# Claude Code SessionEnd hook: log the finished local session on the Multica
# board as a done issue (summary + PR link), so work done outside bb is visible
# next to bb's.
#
# Reads the SessionEnd JSON from stdin ({session_id, transcript_path, cwd,
# reason, ...}). Silent no-op unless the `multica` CLI is installed and logged
# in (`multica login`), and jq is available. Never blocks or fails the session:
# the work runs detached and every error is swallowed.
#
# Env:
#   MULTICA_SESSION_HOOK=0                  disable
#   MULTICA_SESSION_HOOK_WORKSPACE_ID=<id>  target workspace (default: CLI default)
#   MULTICA_SESSION_HOOK_MIN_TURNS=1        skip sessions with fewer assistant replies
#   MULTICA_SESSION_HOOK_LOG=<file>         debug log (default: none)
set -u

[ "${MULTICA_SESSION_HOOK:-1}" = "0" ] && exit 0
command -v multica >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"

run() {
  set -u
  local session transcript cwd reason
  session="$(jq -r '.session_id // empty' <<<"$INPUT")"
  transcript="$(jq -r '.transcript_path // empty' <<<"$INPUT")"
  cwd="$(jq -r '.cwd // empty' <<<"$INPUT")"
  reason="$(jq -r '.reason // "other"' <<<"$INPUT")"
  [ -n "$session" ] && [ -f "$transcript" ] || return 0
  [ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true

  # Logged in? (`auth status` fails when no token is configured.)
  multica auth status >/dev/null 2>&1 || return 0

  # Once per session, even if the session is resumed and ends again.
  local marker_dir="${XDG_CACHE_HOME:-$HOME/.cache}/multica-session-hook"
  mkdir -p "$marker_dir" 2>/dev/null || return 0
  [ -e "$marker_dir/$session" ] && return 0

  local turns summary
  turns="$(jq -s '[.[] | select(.type == "assistant")] | length' "$transcript" 2>/dev/null || echo 0)"
  [ "${turns:-0}" -ge "${MULTICA_SESSION_HOOK_MIN_TURNS:-1}" ] || return 0
  # Last assistant text block is the session's closing summary.
  summary="$(jq -rs '[.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text] | last // ""' "$transcript" 2>/dev/null)"
  first_prompt="$(jq -rs '[.[] | select(.type == "user") | .message.content | if type == "string" then . else ([.[]? | select(.type == "text") | .text] | first // "") end | select(. != "")] | first // ""' "$transcript" 2>/dev/null)"

  local repo branch pr
  repo="$(git remote get-url origin 2>/dev/null | sed -E 's#(git@|https://)([^/:]+)[:/]##; s#\.git$##')"
  [ -n "$repo" ] || repo="$(basename "$cwd")"
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  pr="$(grep -oE 'https://github\.com/[^/" ]+/[^/" ]+/pull/[0-9]+' "$transcript" 2>/dev/null | tail -1)"
  if [ -z "$pr" ] && command -v gh >/dev/null 2>&1 && [ -n "$branch" ]; then
    pr="$(timeout 10 gh pr view "$branch" --json url -q .url 2>/dev/null || true)"
  fi

  local title_src title ws_flag=()
  title_src="${first_prompt:-$summary}"
  title="$(printf '%s' "$title_src" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-90)"
  [ -n "$title" ] || title="Claude Code session"
  title="[local] ${repo}${branch:+@$branch}: $title"
  [ -n "${MULTICA_SESSION_HOOK_WORKSPACE_ID:-}" ] && ws_flag=(--workspace-id "$MULTICA_SESSION_HOOK_WORKSPACE_ID")

  local desc id comment
  desc="Local Claude Code session \`${session}\` in \`${repo}\`${branch:+ on branch \`$branch\`} (ended: ${reason})."
  id="$(multica issue create "${ws_flag[@]}" --title "$title" --description "$desc" --allow-duplicate --output json 2>/dev/null | jq -r '.identifier // .id // empty')"
  [ -n "$id" ] || return 0
  comment="${summary:-_(no summary)_}"
  [ -n "$pr" ] && comment="$comment

Pull request: $pr"
  multica issue comment add "${ws_flag[@]}" "$id" --content "$comment" >/dev/null 2>&1
  multica issue status "${ws_flag[@]}" "$id" "done" >/dev/null 2>&1
  touch "$marker_dir/$session"
}

# Detach so a slow network never delays Claude Code's exit.
if [ -n "${MULTICA_SESSION_HOOK_LOG:-}" ]; then
  ( run >>"$MULTICA_SESSION_HOOK_LOG" 2>&1 & )
else
  ( run >/dev/null 2>&1 & )
fi
exit 0
