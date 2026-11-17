#!/bin/sh
# Entrypoint for the multica-daemon-bb image.
#
# Required: MULTICA_SERVER_URL, MULTICA_BB_ENDPOINT, and a personal access token
#           in MULTICA_PAT or in the file named by MULTICA_PAT_FILE.
# Optional: MULTICA_BB_TOKEN, MULTICA_BB_SILENCE_TIMEOUT, MULTICA_BB_PUT_ATTEMPTS,
#           any upstream MULTICA_DAEMON_* / MULTICA_AGENT_* setting.
set -eu

: "${MULTICA_SERVER_URL:?MULTICA_SERVER_URL is required}"
: "${MULTICA_BB_ENDPOINT:?MULTICA_BB_ENDPOINT is required (bb base URL)}"

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
: "${MULTICA_PAT:?set MULTICA_PAT or MULTICA_PAT_FILE (a mul_ personal access token)}"

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

exec multica daemon start --foreground "$@"
