# bb HTTP contract, v1

This is what the Multica daemon's `bb` backend (`bb-backend/bb.go`) expects from bb.
`mock-bb/` implements all of it, so it's the reference implementation for tests.
Real bb should conform before phase 2.

All requests carry `Authorization: Bearer <MULTICA_BB_TOKEN>`. All bodies are JSON.
Task IDs are opaque strings: Multica task UUIDs, plus `<uuid>:turn<n>` for a same-task follow-up turn.
Path segments are URL-escaped.

## `GET /health`

```json
{ "protocolVersion": 1, "version": "bb-2026.11.3" }
```

The daemon only registers the bb runtime while this answers.
A different `protocolVersion` demotes the runtime, because a protocol mismatch is deterministic and won't fix itself on retry.

## `PUT /tasks/{id}`: idempotent create

```json
{
  "protocolVersion": 1,
  "taskId": "01a1eb9c-…",              // == {id}
  "multicaTaskId": "01a1eb9c-…",
  "retryOf": "01a1eb9b-…",             // optional, see "Retry lineage"
  "attempt": 2,
  "prompt": "…",                       // the daemon's per-task prompt
  "systemPrompt": "…",                 // Multica runtime brief (CLI usage, workflow, agent persona)
  "resumeSessionId": "bbsess-…",       // optional: continue this bb session
  "model": "",
  "issue": { "id": "…", "identifier": "ENG-42" },
  "chatSessionId": "",
  "repos": [{ "url": "https://github.com/acme/app", "ref": "main" }],
  "multica": { "serverUrl": "https://multica.example.com", "workspaceId": "…", "taskToken": "mat_…" }
}
```

Response (200):

```json
{ "taskId": "<canonical run id>", "created": true, "status": "running",
  "sessionId": "bbsess-…", "lastEventId": 0, "protocolVersion": 1 }
```

- **Return 200 only once the task is durably stored.** The daemon treats any non-200 as "not stored" and retries.
- **Same ID again means "already have it".** Return 200 with `created: false` and the existing run. Never start a second run.
- **Retry lineage.** When `retryOf` is set and `{id}` is unknown, resolve `retryOf` to a run. It may be an alias itself, so follow the chain. If a run is found, record `{id}` as an alias of it and answer `created: false` with the canonical `taskId`.
  - Multica's automatic retries (after `runtime_offline`, `runtime_recovery` or `timeout`) are new task rows whose parent is the failed attempt. This rule is what keeps them at one bb run.
  - A manual rerun has no `retryOf` and must start a fresh run.
- **Errors.** Answer 400, 401, 403, 409 or 422 for permanent refusals; the daemon fails the task without retrying. Answer 5xx or 429 for transient problems; the daemon retries with exponential backoff and jitter, 12 attempts by default (about 2–3 minutes).
- **Tombstones.** If `{id}` was cancelled before it was created (see cancel below), answer 409.
- **Session continuity.** `resumeSessionId` names the Durable Object session to continue. Return the session in `sessionId`. The daemon pins it on the Multica task immediately, and the next task on the same issue sends it back as `resumeSessionId`.
- **Credentials.** `multica.taskToken` is a task-scoped Multica credential. bb uses it to read the issue and post comments or status as the agent (`MULTICA_TOKEN` for the `multica` CLI). It expires with the task.

## `GET /tasks/{id}/events?since=N`: resumable SSE stream

`{id}` may be the canonical ID or any alias.
Respond with `Content-Type: text/event-stream` and send every event with `id > N` in order. Then keep the stream open and push new events as they're written. Close the stream after the `result` event.
`Last-Event-ID` is also sent, and `since` wins if both are present.

```
id: 7
event: tool_call
data: {"id":7,"kind":"tool_call","phase":"start","callId":"c3","tool":"bash","input":{"command":"go test ./..."}}

```

**Event IDs** are per run, start at 1, and go up by exactly 1 with no gaps. The daemon drops IDs it has already seen, so replaying from `since=0` is always safe, and it logs gaps.

| kind | fields | maps to Multica |
| --- | --- | --- |
| `thought` | `text` | thinking message |
| `text` | `text` | text message; also the fallback answer if `result.summary` is empty |
| `tool_call` | `phase` (`start`\|`end`), `callId`, `tool`, `input` (start), `output` (end) | tool-use / tool-result |
| `heartbeat` | — | status message with no transcript row; resets the daemon's idle watchdog |
| `error` | `message` | error message. **Not terminal.** |
| `result` | `status` (`succeeded`\|`failed`\|`cancelled`), `summary`, `prUrl`, `sessionId`, `error` | the task's final result. `summary` and the PR link become the agent's comment. |

**Heartbeats.** Emit one at least every 30s while working, including during long tool calls. If the daemon sees no event (heartbeats included) for `MULTICA_BB_SILENCE_TIMEOUT` (default 10m), it ends that attempt as `timeout`.
It does **not** cancel bb on silence: Multica retries the attempt, and the retry reattaches through `retryOf`.
SSE comment lines (`: keepalive`) are allowed for proxies, but they don't count as liveness.

## `POST /tasks/{id}/cancel`

- **Idempotent.** Write a `result` event with `status: "cancelled"` and stop the run. Answer 200.
- **Unknown ID.** Record a tombstone so a PUT that arrives late answers 409 instead of starting a run. This happens when the user cancels while the daemon is still retrying its PUT.

## When the daemon cancels and when it doesn't

| Situation | Daemon does |
| --- | --- |
| User cancels in the UI or CLI | `POST /cancel` |
| `MULTICA_AGENT_TIMEOUT` exceeded (operator cost cap) | `POST /cancel` |
| Daemon receives SIGTERM or SIGINT (deploy, restart) | **No cancel.** The run keeps going and the retry reattaches. |
| Daemon crashes (SIGKILL, OOM) | Nothing, obviously. The retry reattaches. |
| bb silent past the silence timeout | **No cancel.** Attempt fails as `timeout` and the retry reattaches. |

## Implementing this on bb (OpenCode service in k8s)

bb hosts OpenCode with `@opencode/sdk`, which runs the OpenCode server in-process. The same SDK has a Cloudflare profile (`@opencode/sdk/workerd`, [docs](https://opencode.ai/docs/build/sdk/cloudflare)) that keeps "durable events" in Durable Object storage. Those durable events are for **host eviction recovery only**. OpenCode's client-facing stream (`opencode.events.subscribe()`) is **live-only: no replay, no automatic reconnection**, and a late subscriber gets only a `server.connected` marker.

So the resumable `since=N` stream has to be built by bb, on its Postgres mailbox. That's the only layer that can give the daemon gap-free, replayable events across reconnects and pod restarts.

```sql
-- One row per Multica task id that has ever been PUT (or cancelled first).
create table bb_task (
  task_id     text primary key,          -- Multica task id or "<id>:turn<n>"
  run_id      text not null,             -- canonical run; = task_id unless aliased
  status      text not null,             -- running | succeeded | failed | cancelled
  session_id  text,                      -- OpenCode sessionID (resumeSessionId)
  request     jsonb,
  created_at  timestamptz not null default now()
);
create table bb_event (
  run_id  text   not null,
  seq     bigint not null,               -- 1, 2, 3 … per run (the SSE id)
  kind    text   not null,
  body    jsonb  not null,               -- large payloads: S3 key, not inline
  primary key (run_id, seq)
);
```

**PUT, in one transaction:**
1. `select … for update` the `task_id`. If the row exists, return it (`created: false`). A tombstone (cancelled, no run) returns 409.
2. If `retryOf` is set, resolve `retryOf → run_id` through `bb_task` and insert `(task_id, run_id = parent's run_id)` as an alias.
3. Otherwise insert `(task_id, run_id = task_id, status = running)` and enqueue the run on the mailbox.

Commit, then answer 200.

**Run worker:**
1. Claim the mailbox row.
2. Call `opencode.sessions.create()` (or reuse `resumeSessionId`), then `sessions.prompt()`.
3. Consume `events.subscribe()`. Map each OpenCode event to a contract event and `insert into bb_event (run_id, seq, …)`, with `seq` as `max+1` under the run's lock, or a per-run counter column.
4. Emit a `heartbeat` row every ~15–30s while the session is busy, especially during long tool calls.
5. On completion, write the `result` row and set `bb_task.status`.

If a pod dies mid-run, the mailbox lease expires and another worker resumes the OpenCode session, continuing `seq` from the last row.

**Events endpoint:** `select … where run_id = $1 and seq > $since order by seq`, then wait on `LISTEN bb_event_<run>` (or poll) for new rows. Close after the `result` row.

**Cancel:** abort the active prompt (the SDK's AbortSignal or session abort), write the `cancelled` result row, and mark the task row. For an unknown id, insert a tombstone row.

**Callbacks to Multica:** the agent calls Multica with `multica.taskToken` (`MULTICA_TOKEN`) and `multica.serverUrl`. With both services in the same cluster, that's the backend Service URL. No public exposure is needed, but the daemon sends the URL it uses itself, so give the daemon an in-cluster `MULTICA_SERVER_URL` that bb can also reach.
