# bb domain

bb takes coding tasks from the Multica daemon and runs them with OpenCode. The wire contract is
[`../../docs/bb-contract.md`](../../docs/bb-contract.md). This file is the domain behind it. If the code and this file disagree, fix one of them deliberately, in the same change.

## Task

A **task** is one Multica task ID. Each task lives in exactly one **cell**: a Durable Object addressed by `idFromName(taskId)`, so every bb node reaches the same cell for the same ID. A task is in one of four states:

| State | Meaning |
| --- | --- |
| `Absent` | The cell has never seen this ID. |
| `Run` | The cell owns a **run**: one execution of the agent, with its own event log. `runId = taskId`. |
| `Alias` | The ID is an automatic retry of another task. It points at that task's run and has no log of its own. |
| `Tombstone` | The task was cancelled before it was created. A later create is refused. |

A run's `status` is `running`, then exactly one of `succeeded`, `failed` or `cancelled`.

## Commands

All state changes go through `decide(task, command) → Result<Decision, DomainError>`. It's pure: no clock, no randomness, no IDs. Callers pass `now` in.

| Command | `Absent` | `Run` | `Alias` | `Tombstone` |
| --- | --- | --- | --- | --- |
| `Create` (from PUT, no parent run found) | → `Run` (running) | unchanged, `AlreadyExists` | unchanged, `AlreadyExists` | refused (`Tombstoned`) |
| `AliasTo(runId)` (PUT with `retryOf` that resolved) | → `Alias` | unchanged, `AlreadyExists` | unchanged, `AlreadyExists` | refused (`Tombstoned`) |
| `Record(events, cursor)` (agent progress) | error | running: append; terminal: unchanged | error | error |
| `Cancel` | → `Tombstone` | running: append `result: cancelled`; terminal: unchanged | error (the app forwards to the run) | unchanged |

`Record` assigns each event the next sequence number. A `result` event ends the run: its `status` becomes the run status, events after it in the same batch are dropped, and it always carries a `sessionId` (the run's own if the runtime did not name one), so the caller can resume the session next turn.

## The event log

Each run has an append-only log of contract events (`thought`, `text`, `tool_call`, `heartbeat`, `error`, `result`). Each entry's `id` is its sequence number.

## Invariants

Each has a property-based test that names it (`test/domain.test.ts`).

1. **Contiguous log.** A run's event IDs are 1, 2, 3 … with no gaps and no reuse.
2. **Closed after result.** A run's log contains at most one `result`, it is the last entry, and nothing is appended after it.
3. **Idempotent create.** `Create` or `AliasTo` on an existing task changes nothing and appends nothing. One task ID never yields a second run.
4. **Tombstones are final.** A tombstoned task never becomes a run or an alias.
5. **Aliases have no log.** An alias never holds events; reading or cancelling it goes to its run.
6. **Status matches the log.** A run is `running` exactly when its log has no `result`; otherwise its status is that result's status.

## Lineage

Multica creates a new task row for each automatic retry, with `parent_task_id` pointing at the failed attempt, and the daemon sends it as `retryOf`. On `Create` with `retryOf`, the app asks the parent's cell to **resolve** it: a run returns its own ID, an alias returns its target, an absent task returns nothing. If a run ID comes back, the new task becomes an `Alias` of it; otherwise it becomes a new `Run`. A chain of retries therefore always lands on the first run.

## Sessions

A run's agent is OpenCode, in a **session cell**: one Durable Object per OpenCode session (`idFromName(sessionId)`, ids `ses_bb_<runId>`). Task cells hold bb's state and event log and reach their session cell through `sessionCellRuntime`.

A reply in Multica is a *new task* carrying the previous session id. It resolves to the same session cell, so the conversation's history is there. Each run is one prompt into the session, with id `msg_bb_<runId>`. Its events are the session's durable log after that prompt.

`start` is idempotent because it checks the log for the prompt: OpenCode would run a repeated prompt id again.

## Models

OpenCode's model is configuration, not code (`BB_MODEL`, `src/adapters/model`):

| `BB_MODEL` | Model | Reaches |
| --- | --- | --- |
| `scripted` (default) | A stand-in that speaks Anthropic's Messages API from inside the Worker: deterministic, no key. | nothing |
| `claude` | Claude over Anthropic's API, `ANTHROPIC_API_KEY`; `BB_CLAUDE_MODEL` (default `claude-opus-5-5`). | the API host only |

Both use OpenCode's Anthropic-compatible provider, and OpenCode's outbound `fetch` reaches only the model's host. celld has only plain vars, so a key is stored with the deployment in the fleet bucket: acceptable on kind, not in production. Production will use Bedrock with the pod's IAM role; the Worker cannot see the pod's credentials, so a signing proxy next to celld will sign requests (a later mode).

## Where things live

| Layer | Folder | May import |
| --- | --- | --- |
| Domain (this file) | `src/domain` | `effect` only |
| Ports (Effect services) | `src/ports` | domain, `effect` |
| Use cases + HTTP handlers | `src/app` | ports, domain |
| Adapters (fake, Durable Object incl. session cells, Postgres, OpenCode, scripted model; Claude and agent-sandbox next) | `src/adapters/*` | anything |
| Composition roots | `src/worker` (celld), `src/dev` | anything |
