#!/usr/bin/env bash
# Apply our overlay onto an upstream Multica checkout:
#   1. copy the bb backend + daemon glue files into the upstream tree
#   2. apply patches/register-bb.patch (idempotent: skipped if already applied)
#
# Usage: scripts/apply-overlay.sh [UPSTREAM_DIR]   (default: ./upstream)
# Used by Dockerfile.daemon, CI and `make overlay`. Undo with scripts/reset-overlay.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="$(cd "${1:-$ROOT/upstream}" && pwd)"
PATCH="$ROOT/patches/register-bb.patch"

[ -f "$UP/server/pkg/agent/agent.go" ] || { echo "not an upstream multica checkout: $UP" >&2; exit 1; }

cp "$ROOT/bb-backend/bb.go" "$ROOT/bb-backend/bb_test.go" "$UP/server/pkg/agent/"
cp "$ROOT/bb-backend/daemon_bb.go" "$ROOT/bb-backend/daemon_bb_test.go" "$UP/server/internal/daemon/"

cd "$UP"
if git apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "overlay: patch already applied"
else
  git apply --whitespace=nowarn "$PATCH"
  echo "overlay: patch applied"
fi
