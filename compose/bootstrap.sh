#!/bin/sh
# Creates (or reuses) the admin user, a workspace and a PAT for the daemon, and
# writes them to the shared /state volume. Idempotent. Test harness only: it
# relies on MULTICA_DEV_VERIFICATION_CODE.
set -eu
API="${MULTICA_SERVER_URL:-http://backend:8080}"
EMAIL="${BOOTSTRAP_EMAIL:-bb-admin@example.com}"
CODE="${MULTICA_DEV_VERIFICATION_CODE:?}"

if [ -s /state/pat ] && curl -sf -H "Authorization: Bearer $(cat /state/pat)" "$API/api/me" >/dev/null; then
  echo "bootstrap: existing PAT still valid"; exit 0
fi

until curl -sf "$API/health" >/dev/null; do sleep 2; done
post() { curl -sf -X POST -H 'Content-Type: application/json' "$@"; }

post "$API/auth/send-code" -d "{\"email\":\"$EMAIL\"}" >/dev/null
JWT="$(post "$API/auth/verify-code" -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | jq -r .token)"
[ -n "$JWT" ] && [ "$JWT" != null ] || { echo "bootstrap: login failed" >&2; exit 1; }
AUTH="Authorization: Bearer $JWT"

WS="$(curl -sf -H "$AUTH" "$API/api/workspaces" | jq -r 'if type=="array" then (.[0].id // empty) else (.workspaces[0].id // empty) end')"
if [ -z "$WS" ]; then
  WS="$(post -H "$AUTH" "$API/api/workspaces" -d '{"name":"bb test","slug":"bb-test","issue_prefix":"BB"}' | jq -r .id)"
fi
PAT="$(post -H "$AUTH" "$API/api/tokens" -d '{"name":"bb-daemon (compose)"}' | jq -r .token)"
case "$PAT" in mul_*) ;; *) echo "bootstrap: PAT creation failed" >&2; exit 1 ;; esac

umask 077
printf '%s' "$PAT" > /state/pat.tmp && mv /state/pat.tmp /state/pat
printf '%s' "$WS" > /state/workspace_id
chmod 644 /state/pat /state/workspace_id   # read by the non-root daemon user
echo "bootstrap: workspace $WS ready; PAT written"
