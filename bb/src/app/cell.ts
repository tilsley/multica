import { Clock, Context, Effect, Option, Result, Stream } from "effect"
import {
  type AgentEvent,
  decide,
  type Command,
  type Decision,
  type LogEntry,
  resolveRun,
  type Task,
  type TaskRequest
} from "../domain/index.ts"
import {
  AgentRuntime,
  type CancelResult,
  CellRejected,
  CellStore,
  CellUnavailable,
  Mailbox,
  type PutResult,
  Scheduler,
  type StorageError,
  type TaskSummary
} from "../ports/index.ts"

// Use cases that run inside ONE task's cell (docs/domain.md). Everything here
// goes through decide(); nothing reads the clock except via Clock.

export class CellSettings extends Context.Service<
  CellSettings,
  {
    /** How often a running cell asks the runtime for progress. */
    readonly tickMs: number
    /** Longest an events stream waits for a new entry before re-checking. */
    readonly pollMs: number
  }
>()("bb/CellSettings") {}

export type CellServices = CellStore | Scheduler | AgentRuntime | Mailbox | CellSettings

const unavailable = (e: StorageError) => new CellUnavailable({ reason: e.reason })

const summarize = (task: Task, now: number): TaskSummary => ({
  taskId: task.taskId,
  runId: resolveRun(task),
  state: task._tag,
  status: task._tag === "Run" ? task.status : undefined,
  sessionId: task._tag === "Run" ? task.sessionId : undefined,
  issue: task._tag === "Run" ? task.request.issue?.identifier : undefined,
  resumedFrom: task._tag === "Run" ? task.request.resumeSessionId : undefined,
  eventCount: task._tag === "Run" ? task.lastSeq : 0,
  createdAt: task._tag === "Run" ? task.createdAt : task._tag === "Absent" ? now : task.at,
  updatedAt: now
})

/** decide, commit, then index. The index is best effort: the cell is the truth. */
const apply = Effect.fnUntraced(function* (command: (now: number) => Command) {
  const store = yield* CellStore
  const mailbox = yield* Mailbox
  const now = yield* Clock.currentTimeMillis
  const task = yield* store.load.pipe(Effect.mapError(unavailable))
  const result = decide(task, command(now))
  if (Result.isFailure(result)) return result
  const decision: Decision = result.success
  if (decision.outcome !== "AlreadyExists" && decision.outcome !== "Unchanged") {
    yield* store.commit(decision.task, decision.appended).pipe(Effect.mapError(unavailable))
    yield* mailbox.record(summarize(decision.task, now)).pipe(
      Effect.tapError((e) => Effect.logWarning("mailbox index write failed; the cell stays authoritative", { reason: e.reason })),
      Effect.ignore
    )
  }
  return result
})

const putResult = (task: Task, created: boolean): PutResult => {
  switch (task._tag) {
    case "Run":
      return { taskId: task.runId, created, status: task.status, sessionId: task.sessionId, lastEventId: task.lastSeq }
    case "Alias":
      return { taskId: task.runId, created: false, status: "running", sessionId: "", lastEventId: 0 }
    case "Absent":
    case "Tombstone":
      return { taskId: task.taskId, created: false, status: task._tag, sessionId: "", lastEventId: 0 }
  }
}

export const defaultSessionId = (runId: string) => `bbsess-${runId}`

/**
 * PUT: creates the run (or the alias when the front resolved `retryOf` to a run).
 * Returns once the task is durable in the cell. For an alias, the caller asks the
 * run's cell for its session and position.
 */
export const put = Effect.fn("cell.put")(function* (request: TaskRequest, parentRunId: string | undefined) {
  const scheduler = yield* Scheduler
  const result = yield* apply((now) =>
    parentRunId === undefined
      ? { _tag: "Create", request, sessionId: request.resumeSessionId ?? defaultSessionId(request.taskId), now }
      : { _tag: "AliasTo", runId: parentRunId, now }
  )
  if (Result.isFailure(result)) {
    return yield* new CellRejected({ status: 409, reason: result.failure.reason })
  }
  const { task, outcome } = result.success
  if (outcome === "Created") yield* scheduler.wakeIn(0).pipe(Effect.mapError(unavailable))
  return putResult(task, outcome === "Created" || outcome === "Aliased")
})

export const describe = Effect.gen(function* () {
  const store = yield* CellStore
  return putResult(yield* store.load.pipe(Effect.mapError(unavailable)), false)
})

export const resolve = Effect.gen(function* () {
  const store = yield* CellStore
  return resolveRun(yield* store.load.pipe(Effect.mapError(unavailable)))
})

/** The run's log from `since`, live, ending after the result entry. */
export const events = Effect.fn("cell.events")(function* (since: number) {
  const store = yield* CellStore
  const { pollMs } = yield* CellSettings
  const task = yield* store.load.pipe(Effect.mapError(unavailable))
  if (task._tag !== "Run") {
    return yield* new CellRejected({ status: 404, reason: `task ${task.taskId} has no run here (${task._tag})` })
  }
  type Cursor = { readonly after: number; readonly done: boolean }
  const page = (cursor: Cursor) =>
    Effect.gen(function* () {
      const entries: ReadonlyArray<LogEntry> = yield* store.readLog(cursor.after, 500).pipe(Effect.orDie)
      if (entries.length === 0) {
        yield* store.awaitAppend(cursor.after, pollMs)
        return [[], Option.some({ ...cursor })] as const
      }
      const last = entries.at(-1)
      const after = last ? last.id : cursor.after
      const done = entries.some((e) => e.kind === "result")
      return [entries, done ? Option.none<Cursor>() : Option.some({ after, done })] as const
    })
  const start: Cursor = { after: since, done: false }
  return Stream.paginate(start, page)
})

/** Cancel: stops a running run, or tombstones a task that does not exist yet. */
export const cancel = Effect.fn("cell.cancel")(function* () {
  const runtime = yield* AgentRuntime
  const scheduler = yield* Scheduler
  const store = yield* CellStore
  const before = yield* store.load.pipe(Effect.mapError(unavailable))
  if (before._tag === "Alias") return { _tag: "IsAlias", runId: before.runId } satisfies CancelResult
  if (before._tag === "Run" && before.status === "running") {
    yield* runtime.cancel(before.runId).pipe(
      Effect.tapError((e) => Effect.logWarning("runtime cancel failed; recording the cancellation anyway", { reason: e.reason })),
      Effect.ignore
    )
  }
  const result = yield* apply((now) => ({ _tag: "Cancel", now }))
  if (Result.isFailure(result)) return yield* new CellRejected({ status: 409, reason: result.failure.reason })
  const { task } = result.success
  if (task._tag === "Run") {
    yield* scheduler.cancel.pipe(Effect.mapError(unavailable))
    return { _tag: "Cancelled", taskId: task.runId, status: task.status } satisfies CancelResult
  }
  return { _tag: "Tombstoned", taskId: task.taskId } satisfies CancelResult
})

/**
 * One step of a running run: start the runtime if needed, record its progress, and
 * schedule the next step. Safe to repeat after a crash: the cursor and the log commit
 * together, and the runtime's start is idempotent.
 */
export const tick = Effect.fn("cell.tick")(function* () {
  const store = yield* CellStore
  const runtime = yield* AgentRuntime
  const scheduler = yield* Scheduler
  const { tickMs } = yield* CellSettings
  const task = yield* store.load.pipe(Effect.mapError(unavailable))
  if (task._tag !== "Run" || task.status !== "running") return

  const progressed = yield* Effect.gen(function* () {
    const from =
      task.cursor === ""
        ? yield* runtime.start({ runId: task.runId, sessionId: task.sessionId, request: task.request })
        : task.cursor
    return yield* runtime.progress(task.runId, from)
  }).pipe(Effect.result)

  let reported: ReadonlyArray<AgentEvent>
  let cursor = task.cursor
  if (Result.isSuccess(progressed)) {
    reported = progressed.success.events
    cursor = progressed.success.cursor
  } else if (progressed.failure.retryable) {
    yield* Effect.logWarning("runtime unavailable; retrying next tick", { reason: progressed.failure.reason })
    reported = []
  } else {
    reported = [{ kind: "result", status: "failed", error: progressed.failure.reason, sessionId: task.sessionId }]
  }

  if (reported.length > 0 || cursor !== task.cursor) {
    const recorded = yield* apply((now) => ({ _tag: "Record", events: reported, cursor, now }))
    if (Result.isSuccess(recorded) && recorded.success.task._tag === "Run" && recorded.success.task.status !== "running") {
      return
    }
  }
  yield* scheduler.wakeIn(tickMs).pipe(Effect.mapError(unavailable))
})
