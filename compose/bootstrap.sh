#!/usr/bin/env bash
# Run on the HOST (needs curl + jq). Creates or reuses the admin user, a
# workspace and a PAT for the daemon, writing them to compose/.state/.
# Test harness only: relies on MULTICA_DEV_VERIFICATION_CODE being enabled.
set -euo pipefail
cd "$(dirname "$0")"
API="${MULTICA_API:-http://127.0.0.1:${BACKEND_PORT:-8080}}"
EMAIL="${BOOTSTRAP_EMAIL:-bb-admin@example.com}"
CODE="${MULTICA_DEV_VERIFICATION_CODE:-888888}"
STATE=.state
mkdir -p "$STATE"

if [ -s "$STATE/pat" ] && curl -sf -H "Authorization: Bearer $(cat "$STATE/pat")" "$API/api/me" >/dev/null; then
  echo "bootstrap: existing PAT still valid"; exit 0
fi
for _ in $(seq 60); do curl -sf "$API/health" >/dev/null && break; sleep 2; done
post() { curl -sfS -X POST -H 'Content-Type: application/json' "$@"; }

post "$API/auth/send-code" -d "{\"email\":\"$EMAIL\"}" >/dev/null
JWT="$(post "$API/auth/verify-code" -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | jq -r .token)"
[ -n "$JWT" ] && [ "$JWT" != null ] || { echo "bootstrap: login failed" >&2; exit 1; }
AUTH="Authorization: Bearer $JWT"

WS="$(curl -sfS -H "$AUTH" "$API/api/workspaces" | jq -r 'if type=="array" then (.[0].id // empty) else (.workspaces[0].id // empty) end')"
if [ -z "$WS" ]; then
  WS="$(post -H "$AUTH" "$API/api/workspaces" -d '{"name":"bb test","slug":"bb-test","issue_prefix":"BB"}' | jq -r .id)"
fi
PAT="$(post -H "$AUTH" "$API/api/tokens" -d '{"name":"bb-daemon (compose)"}' | jq -r .token)"
case "$PAT" in mul_*) ;; *) echo "bootstrap: PAT creation failed" >&2; exit 1 ;; esac

printf '%s' "$PAT" > "$STATE/pat.tmp" && mv "$STATE/pat.tmp" "$STATE/pat"
printf '%s' "$WS" > "$STATE/workspace_id"
chmod 644 "$STATE/pat" "$STATE/workspace_id"   # read by the container's non-root user
echo "bootstrap: workspace $WS ready; PAT written to $STATE/pat"
