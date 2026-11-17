#!/usr/bin/env bash
# Run every drill in order against a stack started with ../up.sh.
set -euo pipefail
cd "$(dirname "$0")"
for d in 0*.sh; do
  echo; echo "=== $d"; bash "$d"
done
echo; echo "all drills passed"
