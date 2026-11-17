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
