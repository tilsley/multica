#!/bin/sh
# Starts one celld node of the bb fleet. With BB_DEPLOY=1 it first publishes the
# bundled Worker (with vars taken from this environment) to the fleet bucket.
#
#   CELLD_BUCKET   s3://bucket[/prefix]                         (required)
#   S3_ENDPOINT    S3-compatible endpoint, e.g. http://minio:9000
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
#   BB_ADVERTISE   host:port peers use to reach this node's internal listener
#   BB_DEPLOY      1 to publish the deployment first (default: pods named *-0)
#   BB_TOKEN, DATABASE_URL, BB_TEST_ADMIN, BB_TICK_MS, BB_VERSION, BB_AGENT   Worker vars
set -eu
: "${CELLD_BUCKET:?CELLD_BUCKET is required}"
region="${AWS_REGION:-us-east-1}"
endpoint_flag=""
[ -n "${S3_ENDPOINT:-}" ] && endpoint_flag="--endpoint $S3_ENDPOINT"

# In a StatefulSet, pod <name>-0 publishes the deployment unless told otherwise.
if [ -z "${BB_DEPLOY:-}" ]; then
  case "$(cat /etc/hostname 2>/dev/null)" in *-0) BB_DEPLOY=1 ;; *) BB_DEPLOY=0 ;; esac
fi

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if [ "${BB_DEPLOY:-0}" = "1" ]; then
  cat > /app/wrangler.json <<JSON
{
  "name": "bb",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [
    { "name": "TASKS", "class_name": "TaskCell" },
    { "name": "CONTROL", "class_name": "Control" },
    { "name": "SESSIONS", "class_name": "SessionCell" }
  ] },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TaskCell", "Control"] },
    { "tag": "v2", "new_sqlite_classes": ["SessionCell"] }
  ],
  "vars": {
    "BB_TOKEN": "$(json_escape "${BB_TOKEN:-}")",
    "BB_VERSION": "$(json_escape "${BB_VERSION:-dev}")",
    "BB_TEST_ADMIN": "$(json_escape "${BB_TEST_ADMIN:-0}")",
    "BB_TICK_MS": "$(json_escape "${BB_TICK_MS:-1000}")",
    "BB_AGENT": "$(json_escape "${BB_AGENT:-opencode}")",
    "DATABASE_URL": "$(json_escape "${DATABASE_URL:-}")"
  }
}
JSON
  # celld bundles with esbuild; use the native binary from production deps.
  if [ -z "${CELLD_ESBUILD:-}" ]; then
    for candidate in /app/node_modules/@esbuild/*/bin/esbuild; do
      [ -x "$candidate" ] && CELLD_ESBUILD="$candidate" && export CELLD_ESBUILD && break
    done
  fi
  echo "bb: publishing deployment to $CELLD_BUCKET"
  # The bucket can lag the node start (MinIO coming up): retry.
  i=0
  until celld deploy /app/wrangler.json --bucket "$CELLD_BUCKET" $endpoint_flag --region "$region"; do
    i=$((i + 1)); [ "$i" -ge 30 ] && { echo "bb: deploy failed" >&2; exit 1; }
    sleep 2
  done
fi

# Wait until the bucket answers before starting: celld exits if the bucket is
# unreachable at start, which shows up as restarts while MinIO is still booting.
i=0
# shellcheck disable=SC2086
until celld diagnose --bucket "$CELLD_BUCKET" $endpoint_flag --region "$region" --read-only >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -ge 60 ] && break
  sleep 2
done

advertise_flags=""
if [ -n "${BB_ADVERTISE:-}" ]; then
  advertise_flags="--internal-listen 0.0.0.0:8081 --advertise $BB_ADVERTISE"
fi
# shellcheck disable=SC2086
exec celld --bucket "$CELLD_BUCKET" $endpoint_flag --region "$region" --listen 0.0.0.0:8080 $advertise_flags
