#!/usr/bin/env bash
# Build our images, start the stack, bootstrap a user/workspace/PAT, and make
# sure a "bb" agent exists on the daemon's bb runtime. Idempotent.
#   ./up.sh            # stock server + mock-bb + our daemon
#   ./up.sh --ui       # also start the stock web UI on :3000
set -euo pipefail
cd "$(dirname "$0")"
PROFILE=(); [ "${1:-}" = "--ui" ] && PROFILE=(--profile ui)
# SKIP_BUILD=1 uses images built beforehand (e.g. `make image` with a CA secret
# behind a TLS-intercepting proxy, tagged multica-daemon-bb:local).
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  docker compose "${PROFILE[@]}" build daemon mock-bb
fi
SVC=(postgres backend mock-bb); [ ${#PROFILE[@]} -gt 0 ] && SVC+=(frontend)
docker compose "${PROFILE[@]}" up -d --no-build "${SVC[@]}"
./bootstrap.sh
docker compose "${PROFILE[@]}" up -d --no-build daemon

mc() { docker compose exec -T daemon multica "$@"; }
echo "waiting for the bb runtime to register..."
for _ in $(seq 60); do
  RT="$(mc runtime list --output json 2>/dev/null | jq -r '(if type=="array" then . else .runtimes end)[] | select(.provider=="bb" and .status=="online") | .id' | head -1 || true)"
  [ -n "$RT" ] && break; sleep 2
done
[ -n "${RT:-}" ] || { echo "bb runtime never came online; see: docker compose logs daemon" >&2; exit 1; }
if ! mc agent list --output json | jq -e '(if type=="array" then . else .agents end)[] | select(.name=="bb")' >/dev/null; then
  mc agent create --name bb --runtime-id "$RT" --instructions "bb coding agent" --visibility workspace >/dev/null
fi
echo "ready: backend http://127.0.0.1:${BACKEND_PORT:-8080}  mock-bb http://127.0.0.1:${MOCK_BB_PORT:-8787}/admin/state"
echo "sign in (dev code ${MULTICA_DEV_VERIFICATION_CODE:-888888}) as ${BOOTSTRAP_EMAIL:-bb-admin@example.com}"
