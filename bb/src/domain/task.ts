import { Data, Result } from "effect"
import { type AgentEvent, isResult, type LogEntry, type ResultEvent, type ResultStatus } from "./events.ts"
import type { TaskRequest } from "./request.ts"

// The task state machine (docs/domain.md, "Task" and "Commands"). Pure: callers
// pass `now` and every generated value in.

export type RunStatus = "running" | ResultStatus

export type Task =
  | { readonly _tag: "Absent"; readonly taskId: string }
  | { readonly _tag: "Tombstone"; readonly taskId: string; readonly at: number }
  | { readonly _tag: "Alias"; readonly taskId: string; readonly runId: string; readonly at: number }
  | Run

export interface Run {
  readonly _tag: "Run"
  readonly taskId: string
  readonly runId: string
  readonly status: RunStatus
  readonly sessionId: string
  readonly request: TaskRequest
  readonly createdAt: number
  /** Sequence number of the last log entry (0 before the first). */
  readonly lastSeq: number
  /** Opaque runtime cursor: where the agent runtime's progress was read up to. */
  readonly cursor: string
  readonly lastEventAt: number
}

export type Command =
  | { readonly _tag: "Create"; readonly request: TaskRequest; readonly sessionId: string; readonly now: number }
  | { readonly _tag: "AliasTo"; readonly runId: string; readonly now: number }
  | {
      readonly _tag: "Record"
      readonly events: ReadonlyArray<AgentEvent>
      readonly cursor: string
      readonly now: number
    }
  | { readonly _tag: "Cancel"; readonly now: number }

export type Outcome = "Created" | "Aliased" | "AlreadyExists" | "Recorded" | "Tombstoned" | "Cancelled" | "Unchanged"

export interface Decision {
  readonly task: Task
  readonly appended: ReadonlyArray<LogEntry>
  readonly outcome: Outcome
}

export class Tombstoned extends Data.TaggedError("Tombstoned")<{ readonly reason: string }> {}
export class NotARun extends Data.TaggedError("NotARun")<{ readonly reason: string; readonly task: Task }> {}
export type DomainError = Tombstoned | NotARun

export const absent = (taskId: string): Task => ({ _tag: "Absent", taskId })

const unchanged = (task: Task, outcome: Outcome = "Unchanged"): Result.Result<Decision, DomainError> =>
  Result.succeed({ task, appended: [], outcome })

const notARun = (task: Task, command: Command): Result.Result<Decision, DomainError> =>
  Result.fail(new NotARun({ reason: `${command._tag} needs a run; task ${task.taskId} is ${task._tag}`, task }))

/** Assigns sequence numbers; a result closes the log and drops what follows it. */
const append = (run: Run, events: ReadonlyArray<AgentEvent>, now: number) => {
  const appended: Array<LogEntry> = []
  let result: ResultEvent | undefined
  for (const event of events) {
    const id = run.lastSeq + appended.length + 1
    if (isResult(event)) {
      // A result always names the session, so the caller can resume it next turn.
      result = { ...event, sessionId: event.sessionId ?? run.sessionId }
      appended.push({ ...result, id, at: now })
      break
    }
    appended.push({ ...event, id, at: now })
  }
  const last = appended.at(-1)
  const next: Run = {
    ...run,
    lastSeq: last ? last.id : run.lastSeq,
    lastEventAt: last ? now : run.lastEventAt,
    status: result ? result.status : run.status,
    sessionId: result?.sessionId ?? run.sessionId
  }
  return { run: next, appended }
}

export const decide = (task: Task, command: Command): Result.Result<Decision, DomainError> => {
  switch (command._tag) {
    case "Create":
      switch (task._tag) {
        case "Absent":
          return Result.succeed({
            task: {
              _tag: "Run",
              taskId: task.taskId,
              runId: task.taskId,
              status: "running",
              sessionId: command.sessionId,
              request: command.request,
              createdAt: command.now,
              lastSeq: 0,
              cursor: "",
              lastEventAt: command.now
            },
            appended: [],
            outcome: "Created"
          })
        case "Tombstone":
          return Result.fail(new Tombstoned({ reason: `task ${task.taskId} was cancelled before it was created` }))
        case "Run":
        case "Alias":
          return unchanged(task, "AlreadyExists")
      }
      break
    case "AliasTo":
      switch (task._tag) {
        case "Absent":
          return Result.succeed({
            task: { _tag: "Alias", taskId: task.taskId, runId: command.runId, at: command.now },
            appended: [],
            outcome: "Aliased"
          })
        case "Tombstone":
          return Result.fail(new Tombstoned({ reason: `task ${task.taskId} was cancelled before it was created` }))
        case "Run":
        case "Alias":
          return unchanged(task, "AlreadyExists")
      }
      break
    case "Record":
      if (task._tag !== "Run") return notARun(task, command)
      if (task.status !== "running") return unchanged(task)
      {
        const { run, appended } = append(task, command.events, command.now)
        return Result.succeed({ task: { ...run, cursor: command.cursor }, appended, outcome: "Recorded" })
      }
    case "Cancel":
      switch (task._tag) {
        case "Absent":
          return Result.succeed({
            task: { _tag: "Tombstone", taskId: task.taskId, at: command.now },
            appended: [],
            outcome: "Tombstoned"
          })
        case "Tombstone":
          return unchanged(task)
        case "Alias":
          return notARun(task, command)
        case "Run": {
          if (task.status !== "running") return unchanged(task)
          const { run, appended } = append(
            task,
            [{ kind: "result", status: "cancelled", sessionId: task.sessionId }],
            command.now
          )
          return Result.succeed({ task: run, appended, outcome: "Cancelled" })
        }
      }
  }
}

/** Where a task's events live: its own run, an alias's target, or nowhere yet. */
export const resolveRun = (task: Task): string | undefined =>
  task._tag === "Run" ? task.runId : task._tag === "Alias" ? task.runId : undefined
