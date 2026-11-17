#!/usr/bin/env bash
# One upstream tag everywhere: the submodule checkout, the compose stock-image
# tag and the example env must agree. Run in CI and before bumping.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sub="$(git -C "$ROOT/upstream" describe --tags --exact-match HEAD 2>/dev/null)" \
  || { echo "upstream submodule is not on a release tag" >&2; exit 1; }
bad=0
while read -r tag; do
  [ "$tag" = "$sub" ] || { echo "compose/docker-compose.yml pins $tag, submodule is $sub" >&2; bad=1; }
done < <(grep -oE 'MULTICA_IMAGE_TAG:-[^}]+' "$ROOT/compose/docker-compose.yml" | cut -d- -f2- | sort -u)
env_tag="$(grep -E '^MULTICA_IMAGE_TAG=' "$ROOT/compose/.env.example" | cut -d= -f2)"
[ "$env_tag" = "$sub" ] || { echo "compose/.env.example pins $env_tag, submodule is $sub" >&2; bad=1; }
while read -r tag; do
  [ "$tag" = "$sub" ] || { echo "deploy/values.yaml pins $tag, submodule is $sub" >&2; bad=1; }
done < <(grep -E '^\s+tag: v' "$ROOT/deploy/values.yaml" | awk '{print $2}' | sort -u)
[ "$bad" = 0 ] && echo "pins ok: $sub"
exit "$bad"
