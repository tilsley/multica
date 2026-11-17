# multica + bb

This repo runs self-hosted [Multica](https://github.com/multica-ai/multica) as the team-wide agent task board, with **bb**, our Cloudflare coding agent, as the runtime that does the work.

- **Stock and unchanged:** the Multica server, web UI and Postgres, using the official GHCR images and Helm chart.
- **Ours:** a `bb` agent backend for the Multica daemon. We build **only the daemon** from patched upstream source.

```
 Multica UI ──▶ Multica server ◀── WS/HTTP ──▶ multica daemon (ours) ── HTTPS ──▶ bb (Workers/DO)
   (stock)        (stock) + Postgres           pkg/agent "bb" backend           PUT task, SSE events
```

## Layout

| Path | What |
| --- | --- |
| `upstream/` | Git submodule → `multica-ai/multica`, pinned to **v0.10.0**. Never edited in git; the overlay is applied at build time. |
| `bb-backend/bb.go` | The `bb` backend (`agent.Backend`). Copied into `upstream/server/pkg/agent/`. |
| `bb-backend/daemon_bb.go` | Daemon glue: runtime advertisement, `/health` probe, task metadata. Copied into `upstream/server/internal/daemon/`. |
| `bb-backend/*_test.go` | Unit tests plus a contract test, run inside the upstream tree. |
| `patches/register-bb.patch` | The upstream patch: 16 added lines, 1 changed. |
| `mock-bb/` | Fake bb implementing [the contract](docs/bb-contract.md), with failure switches and `/admin/state`. |
| `Dockerfile.daemon` | Builds `multica` (CLI + daemon) from upstream + overlay. |
| `compose/` | Stock Multica + our daemon + mock-bb, a bootstrap script and failure drills. |
| `hooks/claude-session-end.sh` | Claude Code `SessionEnd` hook that logs local sessions as done issues. |
| `deploy/` | Phase 3 starter: values for the official chart plus the daemon Deployment. |
| `docs/bb-contract.md` | The HTTP contract real bb must implement. |

## Quick start

Requires Docker, `curl` and `jq`. Go is fetched automatically from `upstream/server/go.mod` (`GOTOOLCHAIN=auto`).

```bash
git clone --recurse-submodules <this repo> && cd multica
make test            # bb + daemon + mock-bb unit tests
make test-contract   # real backend against a live mock-bb
make up              # compose: stock server + mock-bb + our daemon, bootstrapped
make drills          # failure drills with invariant checks (~6 min; LONG_DRILLS=1 adds ~3)
```

`make up` (`compose/up.sh`) builds the daemon and mock-bb images, starts Postgres, the backend and mock-bb, and creates a user, workspace and PAT through the dev verification code. It then starts the daemon and creates a `bb` agent on its runtime. Use `compose/up.sh --ui` to also start the web UI at <http://localhost:3000>, and sign in as `bb-admin@example.com` with code `888888`.

Then assign work:

```bash
cd compose
docker compose exec daemon multica issue create --title "Add a README badge" --assignee bb
docker compose exec daemon multica issue runs BB-1
curl -s localhost:8787/admin/state | jq '.tasks[] | {id, issue, status, eventCount}'
```

`make down` deletes the stack and its data. The compose stack is a **test harness**: it enables the dev verification code and binds to 127.0.0.1 only.

## How the bb backend works

**Registration.** When `MULTICA_BB_ENDPOINT` is set, the daemon advertises a `bb` runtime. bb has no binary on PATH, so this follows upstream's own `museapp` remote backend. Availability is `GET /health`. The stock server accepts any provider name, so no server change is needed.

**Execute.** For each Multica task:

1. **PUT** `/tasks/{taskId}` with the prompt, inline runtime brief, issue, repos, `resumeSessionId`, and a task-scoped `mat_` token so bb can call the Multica API as the agent.
   - The PUT is retried with exponential backoff and jitter on network errors, 5xx and 429.
   - The default is 12 attempts (about 2–3 minutes). After that the task fails with a clear error. A 4xx fails immediately.
2. **Stream** `GET /tasks/{id}/events?since=N` (SSE).
   - The backend reconnects with `since=<last id>` and drops replays, so there are no duplicates and no gaps.
   - bb events map to Multica messages, and `result` maps to `Result`, with the summary plus the PR link becoming the agent's comment.
3. **Heartbeats.** Each one resets the daemon's idle watchdog without adding a transcript row. If bb sends **no** event for `MULTICA_BB_SILENCE_TIMEOUT` (default 10m), the attempt ends as `timeout`, which Multica retries.
4. **Session continuity.** bb's `sessionId` is pinned to the task immediately. The next task on the issue sends it back as `resumeSessionId`, so a reply continues the same Durable Object session.

### Exactly one bb run per issue trigger

Multica re-queues a task after `runtime_offline`, `runtime_recovery` (daemon restart) or `timeout`. **Each retry is a new task row with a new ID.** So "idempotency key = task ID" alone would start a second bb run on every retry.

The patch decodes the `parent_task_id` that the server already sends in the claim payload. The backend forwards it as `retryOf`, and bb resolves it to the existing run (following alias chains) and reattaches. A manual rerun has no parent and deliberately starts fresh. See [docs/bb-contract.md](docs/bb-contract.md).

### Cancel vs shutdown

Inside `Execute`, a cancelled context means one of two things: either the user cancelled, or the daemon is shutting down (SIGTERM on a deploy). These need opposite handling:

- **User cancel:** `POST /cancel` to bb.
- **Shutdown:** leave the bb run going so the retry reattaches.

The backend tells them apart by observing SIGTERM/SIGINT itself (Go delivers a signal to every `signal.Notify` channel). An operator `MULTICA_AGENT_TIMEOUT` also cancels bb.

## The upstream patch

`patches/register-bb.patch` is about 16 lines. The logic lives in our two copied-in files.

| Hunk | Why it's needed |
| --- | --- |
| `pkg/agent.New`: `case "bb"` | Backend selection is a hard-coded switch. |
| `agents_probe.go`: `bbAgentEntry()` | Runtimes are discovered by probing PATH; bb has no binary. |
| `probeBuiltinRuntime`: `if name == "bb"` | Otherwise version detection tries to resolve and execute a binary. |
| `providerNeedsInlineSystemPrompt`: `"bb"` | The brief normally lands in `AGENTS.md` on the daemon's disk, which bb can't read. |
| `gateResumeToReachableSession`: `bb → reachable` | It drops the resume session when the prior workdir is gone. bb's session lives remotely, and daemon pods are ephemeral. |
| `taskMulticaEnvironment`: `bbTaskEnvironment(...)` | `ExecOptions` carries no issue, repos or retry lineage. `MULTICA_*` keys can't be overridden by an agent's `custom_env`. |
| `types.go`: `ParentTaskID`, `Attempt` | The server already sends them; the daemon didn't decode them. |

Registration needed more than "switch + map + probe". The last four hunks fix silent failures found while reading upstream: a lost brief, lost resume, no repo/issue context, and a duplicate run on every retry. The supported-types map was deliberately **not** touched: it whitelists custom runtime profiles and mirrors a DB CHECK constraint.

`make test` includes `daemon_bb_test.go`, which asserts every hunk. An upstream bump that silently drops one fails CI.

**Bumping upstream:**

1. Run `git -C upstream checkout vX.Y.Z`.
2. Update the tag in `compose/docker-compose.yml`, `compose/.env.example` and `deploy/values.yaml`.
3. Run `make pins test`.
4. If the patch no longer applies, edit the files in `upstream/` and run `make patch`.

Never use anything from `server/ee/` or `packages/ee/`; nothing here does.

## Daemon configuration

| Env | Default | |
| --- | --- | --- |
| `MULTICA_SERVER_URL` | required | Multica API. |
| `MULTICA_PAT` / `MULTICA_PAT_FILE` | required | `mul_` personal access token. The entrypoint runs `multica login --token`. |
| `MULTICA_BB_ENDPOINT` | required | bb base URL. Its presence enables the runtime. |
| `MULTICA_BB_TOKEN` | — | Bearer token for bb. |
| `MULTICA_BB_SILENCE_TIMEOUT` | `10m` | No bb event for this long → attempt `timeout` (retried, reattaches). |
| `MULTICA_BB_PUT_ATTEMPTS` | `12` | PUT attempts before failing the task. |
| `MULTICA_BB_MODEL` | — | Informational model label. |
| `MULTICA_DAEMON_LOG_STDOUT` | `1` | Mirror `~/.multica/daemon.log` to stdout. |

Any upstream `MULTICA_DAEMON_*` or `MULTICA_AGENT_*` setting also applies (see `upstream/CLI_AND_DAEMON.md`). The image disables auto-update and auto-reload. Our Macs can keep running the stock daemon (Claude Code etc.) against the same server.

## Failure drills (`compose/drills/`)

Each drill checks three invariants per retry lineage, using Multica's `issue runs` against mock-bb's `/admin/state`:

1. Exactly one bb run.
2. Nothing lost: the lineage ends in a terminal state.
3. The board status equals bb's status.

| Drill | Expected |
| --- | --- |
| `01-kill-daemon`: SIGTERM and SIGKILL mid-run | `runtime_recovery` → retry reattaches → completed, 1 bb run. |
| `02-bb-503s`: bb answers 503 to everything for 60s | In-flight run reconnects; work assigned during the outage still runs once. |
| `03-cut-network`: daemon↔bb link cut 20s (and 150s with `LONG_DRILLS=1`) | Stream resumes from `since`; the long cut times out, retries and reattaches. |
| `04-cancel`: cancel from the CLI (same API as the UI) | bb receives `POST /cancel`; both sides end `cancelled`. |
| `05-reply`: comment on a finished issue | New run, **same** bb session. |

mock-bb switches: `failFirst`, `failFor`, `acceptThenDrop`, `dropAfter`, `silentFor`, `stepDelay`, `resultAfter`, `heartbeatEvery`, `resultStatus` and `duplicatePut`. Set them through `MOCK_BB_*` env vars, `POST /admin/config` or `X-Mock-*` headers.

## Claude Code hook

`hooks/claude-session-end.sh` logs each local Claude Code session as a **done** issue titled `[local] <repo>@<branch>: <first prompt>`. The comment holds the session's closing summary and the PR link, taken from the transcript or `gh pr view`.

It's a silent no-op unless `multica` is installed and logged in and `jq` is present. It runs detached, so it never slows Claude Code's exit, and logs each session once even if the session is resumed.

```bash
cp hooks/claude-session-end.sh ~/.claude/hooks/ && chmod +x ~/.claude/hooks/claude-session-end.sh
multica login            # once, against our server
```

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/claude-session-end.sh" } ] }
    ]
  }
}
```

Optional settings:

| Env | Effect |
| --- | --- |
| `MULTICA_SESSION_HOOK=0` | Disable the hook. |
| `MULTICA_SESSION_HOOK_WORKSPACE_ID` | Target workspace (default: the CLI's default workspace). |
| `MULTICA_SESSION_HOOK_MIN_TURNS` | Skip sessions with fewer assistant replies. |
| `MULTICA_SESSION_HOOK_LOG=/tmp/hook.log` | Write a debug log. |

## CI (`.github/workflows/ci.yml`)

- **test:** pins agree, patch applies, gofmt, `make test`, `make test-contract`, shellcheck.
- **image:** builds `Dockerfile.daemon` and pushes `ghcr.io/<owner>/multica-daemon-bb:<upstream-tag>-bb-<sha>`, plus `:<upstream-tag>-bb` and `:latest` from `main`. Pull requests build only.
- **drills:** `compose/up.sh` plus every drill on stock GHCR images.

## Phases

1. **Done:** the scaffold above.
2. **Next:** compose against a real bb staging Worker. Set `MULTICA_BB_ENDPOINT` and `MULTICA_BB_TOKEN` in `compose/.env` and run the drills (the mock-specific admin checks need equivalents on bb).
3. **Later:** k8s with the official chart plus `deploy/daemon.yaml` in a test namespace, then a router in front of bb so Slack and GitHub `@bb` triggers create the Multica issue first.
