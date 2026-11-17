#!/usr/bin/env bash
# Return the upstream submodule to its pinned, pristine state.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="${1:-$ROOT/upstream}"
git -C "$UP" checkout -- .
rm -f "$UP/server/pkg/agent/bb.go" "$UP/server/pkg/agent/bb_test.go" "$UP/server/internal/daemon/daemon_bb.go" "$UP/server/internal/daemon/daemon_bb_test.go"
echo "overlay: upstream reset"
