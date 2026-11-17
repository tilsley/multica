#!/usr/bin/env bash
# Start mock-bb, run the bb backend's contract test against it, stop mock-bb.
# Expects the overlay to be applied (make test-contract does that).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADDR="${1:-127.0.0.1:18787}"
BIN="$(mktemp -d)/mock-bb"
(cd "$ROOT/mock-bb" && go build -o "$BIN" .)
"$BIN" -addr "$ADDR" >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -sf "http://$ADDR/health" >/dev/null && break; sleep 0.1; done
cd "$ROOT/upstream/server"
BB_CONTRACT_URL="http://$ADDR" go test -count=1 ./pkg/agent -run BBContract -v
