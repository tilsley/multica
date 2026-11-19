import { Context, Data, type Effect } from "effect"
import type { AgentEvent, LogEntry, Task, TaskRequest } from "../domain/index.ts"

// Every external system bb touches is a port. Each has a fake (src/adapters/fake)
// and one or more real adapters; fake and real pass the same contract tests.

export class StorageError extends Data.TaggedError("StorageError")<{ readonly reason: string }> {}
export class RuntimeError extends Data.TaggedError("RuntimeError")<{ readonly reason: string; readonly retryable: boolean }> {}
export class CellUnavailable extends Data.TaggedError("CellUnavailable")<{ readonly reason: string }> {}

/**
 * The storage of ONE cell: its task and, for a run, its event log. In celld this is
 * the Durable Object's SQLite, so `commit` is atomic and durable before it returns.
 */
export class CellStore extends Context.Service<
  CellStore,
  {
    readonly load: Effect.Effect<Task, StorageError>
    /** Atomically saves the task and appends the entries (already numbered by the domain). */
    readonly commit: (task: Task, appended: ReadonlyArray<LogEntry>) => Effect.Effect<void, StorageError>
    readonly readLog: (afterSeq: number, limit: number) => Effect.Effect<ReadonlyArray<LogEntry>, StorageError>
    /** Completes once the log holds an entry after `afterSeq`, or after `timeoutMs`. */
    readonly awaitAppend: (afterSeq: number, timeoutMs: number) => Effect.Effect<void>
  }
>()("bb/CellStore") {}

/** When this cell should next advance its run. In celld: the Durable Object alarm. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly wakeIn: (delayMs: number) => Effect.Effect<void, StorageError>
    readonly cancel: Effect.Effect<void, StorageError>
  }
>()("bb/Scheduler") {}

export interface RuntimeStart {
  readonly runId: string
  readonly sessionId: string
  readonly request: TaskRequest
}

export interface RuntimeProgress {
  readonly events: ReadonlyArray<AgentEvent>
  /** Opaque; handed back on the next call. Persisted with the run, so it survives eviction. */
  readonly cursor: string
}

/**
 * The coding agent (OpenCode in production). Pull-based: the cell asks for progress
 * since a cursor on every tick, so a cell that was evicted and restarted resumes by
 * asking again with the cursor it persisted. Heartbeats are the runtime's statement
 * that it is still working, so they come from here too.
 */
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    /** Idempotent per runId. Returns the cursor to read progress from. */
    readonly start: (input: RuntimeStart) => Effect.Effect<string, RuntimeError>
    readonly progress: (runId: string, cursor: string) => Effect.Effect<RuntimeProgress, RuntimeError>
    readonly cancel: (input: { readonly runId: string; readonly sessionId: string }) => Effect.Effect<void, RuntimeError>
  }
>()("bb/AgentRuntime") {}

export interface TaskSummary {
  readonly taskId: string
  readonly runId: string | undefined
  readonly state: Task["_tag"]
  readonly status: string | undefined
  readonly sessionId: string | undefined
  readonly issue: string | undefined
  readonly resumedFrom: string | undefined
  readonly eventCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * The mailbox: an index of every task across cells (Postgres in production), for
 * listing, operators and the router. Cells are the source of truth; the index is
 * written after each commit and may briefly lag.
 */
export class Mailbox extends Context.Service<
  Mailbox,
  {
    readonly record: (summary: TaskSummary) => Effect.Effect<void, StorageError>
    readonly list: Effect.Effect<ReadonlyArray<TaskSummary>, StorageError>
  }
>()("bb/Mailbox") {}

/** What the front can ask of one task's cell. */
export interface CellClient {
  readonly put: (request: TaskRequest, parentRunId: string | undefined) => Effect.Effect<PutResult, CellError>
  /** The run's current status, session and position (for answering a PUT that aliased). */
  readonly describe: Effect.Effect<PutResult, CellError>
  /** The run that holds this task's events: its own, an alias's target, or none. */
  readonly resolve: Effect.Effect<string | undefined, CellError>
  readonly events: (since: number) => Effect.Effect<ReadableStream<Uint8Array>, CellError>
  readonly cancel: Effect.Effect<CancelResult, CellError>
}

export interface PutResult {
  readonly taskId: string
  readonly created: boolean
  readonly status: string
  readonly sessionId: string
  readonly lastEventId: number
}

export type CancelResult =
  | { readonly _tag: "Cancelled"; readonly taskId: string; readonly status: string }
  | { readonly _tag: "Tombstoned"; readonly taskId: string }
  | { readonly _tag: "IsAlias"; readonly runId: string }

export class CellRejected extends Data.TaggedError("CellRejected")<{
  readonly status: 400 | 404 | 409 | 422
  readonly reason: string
}> {}
export type CellError = CellRejected | CellUnavailable

/** Reaches the cell for a task ID. In celld: `env.TASKS.getByName(taskId)`. */
export class CellDirectory extends Context.Service<
  CellDirectory,
  { readonly cell: (taskId: string) => CellClient }
>()("bb/CellDirectory") {}

export class SandboxError extends Data.TaggedError("SandboxError")<{ readonly reason: string; readonly retryable: boolean }> {}

export interface WorkspaceSpec {
  /** One workspace per conversation: the same key across a session's runs. */
  readonly key: string
  readonly repos: ReadonlyArray<{ readonly url: string; readonly ref?: string | undefined }>
}

export interface OpenedWorkspace {
  readonly root: string
  /** Each repository's directory inside the sandbox (absolute), in the spec's order. */
  readonly repos: ReadonlyArray<{ readonly url: string; readonly path: string }>
}

export interface ExecRequest {
  readonly argv: ReadonlyArray<string>
  /** Absolute, inside the sandbox. Defaults to the workspace root. */
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly stdin?: Uint8Array | undefined
  readonly timeoutMs?: number | undefined
}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/**
 * Where the agent's work happens. Opening a workspace clones its repositories into
 * bb's own copy, claims an isolated sandbox (agent-sandbox in Kubernetes) and copies
 * the tree in; every agent operation then runs in the sandbox, and `sync` copies the
 * sandbox's changes back into bb's copy. Idempotent per key throughout.
 */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /** The workspace root inside the sandbox, and where each repository is in it. */
    readonly open: (spec: WorkspaceSpec) => Effect.Effect<OpenedWorkspace, SandboxError>
    readonly exec: (key: string, request: ExecRequest) => Effect.Effect<ExecResult, SandboxError>
    /** `undefined` when the file does not exist. */
    readonly readFile: (key: string, path: string) => Effect.Effect<Uint8Array | undefined, SandboxError>
    readonly writeFile: (key: string, path: string, bytes: Uint8Array) => Effect.Effect<void, SandboxError>
    /** Copies the sandbox's changes back into bb's copy; returns the changed paths (relative to the root). */
    readonly sync: (key: string) => Effect.Effect<{ readonly changed: ReadonlyArray<string> }, SandboxError>
    /** Gives the sandbox back. bb's copy stays, so a later `open` continues from it. */
    readonly release: (key: string) => Effect.Effect<void, SandboxError>
  }
>()("bb/Sandboxes") {}
