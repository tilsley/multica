#!/bin/sh
# Entrypoint for the multica-daemon-bb image.
#
# Required: MULTICA_SERVER_URL, MULTICA_BB_ENDPOINT, and a personal access token
#           in MULTICA_PAT or in the file named by MULTICA_PAT_FILE.
# Optional: MULTICA_BB_TOKEN, MULTICA_BB_SILENCE_TIMEOUT, MULTICA_BB_PUT_ATTEMPTS,
#           any upstream MULTICA_DAEMON_* / MULTICA_AGENT_* setting.
#           MULTICA_ENSURE_AGENT=<name>   create an agent with this name on the bb
#                                         runtime once it is online, if none exists.
#           MULTICA_DEV_BOOTSTRAP_EMAIL   TEST CLUSTERS ONLY: with no PAT, sign in with the
#                                         server's dev verification code
#                                         (MULTICA_DEV_VERIFICATION_CODE), create a workspace
#                                         and a PAT. The server ignores the code in production.
set -eu

: "${MULTICA_SERVER_URL:?MULTICA_SERVER_URL is required}"
: "${MULTICA_BB_ENDPOINT:?MULTICA_BB_ENDPOINT is required (bb base URL)}"
api="${MULTICA_SERVER_URL%/}"

post() { wget -qO- --header 'Content-Type: application/json' "$@"; }

dev_bootstrap() {
  email="$MULTICA_DEV_BOOTSTRAP_EMAIL"
  code="${MULTICA_DEV_VERIFICATION_CODE:?MULTICA_DEV_VERIFICATION_CODE is required for the dev bootstrap}"
  until wget -qO- "$api/health" >/dev/null 2>&1; do sleep 2; done
  post --post-data "{\"email\":\"$email\"}" "$api/auth/send-code" >/dev/null
  jwt="$(post --post-data "{\"email\":\"$email\",\"code\":\"$code\"}" "$api/auth/verify-code" | jq -r .token)"
  auth="Authorization: Bearer $jwt"
  ws="$(wget -qO- --header "$auth" "$api/api/workspaces" | jq -r 'if type=="array" then (.[0].id // empty) else (.workspaces[0].id // empty) end')"
  if [ -z "$ws" ]; then
    post --header "$auth" --post-data '{"name":"bb test","slug":"bb-test","issue_prefix":"BB"}' "$api/api/workspaces" >/dev/null
  fi
  post --header "$auth" --post-data '{"name":"bb-daemon"}' "$api/api/tokens" | jq -r .token
}

ensure_agent() {
  name="$1"
  for _ in $(seq 120); do
    rt="$(multica runtime list --output json 2>/dev/null | jq -r '(if type=="array" then . else .runtimes end)[] | select(.provider=="bb" and .status=="online") | .id' | head -1 || true)"
    if [ -n "$rt" ]; then
      if multica agent list --output json | jq -e --arg n "$name" '(if type=="array" then . else .agents end)[] | select(.name==$n)' >/dev/null; then
        echo "agent $name already exists"
      else
        multica agent create --name "$name" --runtime-id "$rt" --instructions "bb coding agent" --visibility workspace >/dev/null && echo "created agent $name"
      fi
      return 0
    fi
    sleep 5
  done
  echo "bb runtime never came online; agent $name not created" >&2
}

if [ -z "${MULTICA_PAT:-}" ] && [ -n "${MULTICA_PAT_FILE:-}" ]; then
  # Compose bootstrap writes the PAT after the server is up; wait for it.
  i=0
  while [ ! -s "$MULTICA_PAT_FILE" ]; do
    i=$((i + 1))
    [ "$i" -gt 300 ] && { echo "timed out waiting for $MULTICA_PAT_FILE" >&2; exit 1; }
    sleep 1
  done
  MULTICA_PAT="$(cat "$MULTICA_PAT_FILE")"
fi
if [ -z "${MULTICA_PAT:-}" ] && [ -n "${MULTICA_DEV_BOOTSTRAP_EMAIL:-}" ]; then
  MULTICA_PAT="$(dev_bootstrap)"
fi
: "${MULTICA_PAT:?set MULTICA_PAT, MULTICA_PAT_FILE or MULTICA_DEV_BOOTSTRAP_EMAIL}"

# The daemon authenticates only from the stored CLI config, never from env, so
# log in on every start (idempotent; also re-discovers watched workspaces).
until multica login --token "$MULTICA_PAT" >/dev/null; do
  echo "login failed; retrying in 3s" >&2
  sleep 3
done
unset MULTICA_PAT

# The foreground daemon writes to a rotating ~/.multica/daemon.log, not stdout.
# Mirror it to stdout so `docker logs` / kubectl logs work (tail -F follows
# rotation). Set MULTICA_DAEMON_LOG_STDOUT=0 to disable.
if [ "${MULTICA_DAEMON_LOG_STDOUT:-1}" != "0" ]; then
  mkdir -p "$HOME/.multica" && touch "$HOME/.multica/daemon.log"
  tail -n 0 -F "$HOME/.multica/daemon.log" 2>/dev/null &
fi

if [ -n "${MULTICA_ENSURE_AGENT:-}" ]; then
  ensure_agent "$MULTICA_ENSURE_AGENT" &
fi

exec multica daemon start --foreground "$@"
