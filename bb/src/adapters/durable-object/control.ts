import { Effect, Schema } from "effect"
import { type Mailbox, StorageError, type TaskSummary } from "../../ports/index.ts"
import {
  applyConfig,
  type FaultState,
  initialFaults,
  judge,
  TestConfig,
  type Verdict
} from "../testkit/faults.ts"
import type { DurableObjectNamespace, DurableObjectState } from "./types.ts"

// The singleton "control" Durable Object: a task index (the Mailbox for celld dev,
// before Postgres) and, in test mode, the shared fault/script state. One cell, so
// every update to it is serialized and durable.

// Stored as JSON; undefined fields are simply absent.
const Summary = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["Absent", "Tombstone", "Alias", "Run"]),
  status: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  resumedFrom: Schema.optionalKey(Schema.String),
  eventCount: Schema.Int,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite
})
const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(Summary))
const toSummary = (s: typeof Summary.Type): TaskSummary => ({
  taskId: s.taskId,
  runId: s.runId,
  state: s.state,
  status: s.status,
  sessionId: s.sessionId,
  issue: s.issue,
  resumedFrom: s.resumedFrom,
  eventCount: s.eventCount,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt
})
const decodeFaults = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ config: TestConfig, requests: Schema.Int, failUntil: Schema.Finite, dropsLeft: Schema.Int })
  )
)

export interface ControlRpc {
  record(summary: TaskSummary): Promise<void>
  list(): Promise<ReadonlyArray<TaskSummary>>
  faults(): Promise<FaultState>
  configure(patch: TestConfig): Promise<FaultState>
  judge(isPut: boolean): Promise<Verdict>
  reset(): Promise<void>
}

export const makeControl = (state: DurableObjectState): ControlRpc => {
  const { sql } = state.storage
  sql.exec("CREATE TABLE IF NOT EXISTS idx (task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL)")
  sql.exec("CREATE TABLE IF NOT EXISTS faults (k INTEGER PRIMARY KEY CHECK (k = 1), body TEXT NOT NULL)")

  const readFaults = (): FaultState => {
    const row = sql.exec<{ body: string }>("SELECT body FROM faults WHERE k = 1").toArray()[0]
    return row ? decodeFaults(row.body) : initialFaults
  }
  const writeFaults = (f: FaultState) =>
    sql.exec("INSERT INTO faults (k, body) VALUES (1, ?) ON CONFLICT (k) DO UPDATE SET body = excluded.body", JSON.stringify(f))

  return {
    record: async (summary) => {
      // created_at keeps the first time the task was seen.
      sql.exec(
        "INSERT INTO idx (task_id, created_at, body) VALUES (?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET body = excluded.body",
        summary.taskId,
        summary.createdAt,
        JSON.stringify(summary)
      )
    },
    list: async () =>
      sql
        .exec<{ body: string }>("SELECT body FROM idx ORDER BY created_at, task_id")
        .toArray()
        .map((r) => toSummary(decodeSummary(r.body))),
    faults: async () => readFaults(),
    configure: async (patch) => {
      const next = applyConfig(readFaults(), patch, Date.now())
      writeFaults(next)
      return next
    },
    judge: async (isPut) => {
      const { next, verdict } = judge(readFaults(), isPut, Date.now())
      writeFaults(next)
      return verdict
    },
    reset: async () => {
      sql.exec("DELETE FROM idx")
      sql.exec("DELETE FROM faults")
    }
  }
}

const storageError = (e: unknown) => new StorageError({ reason: e instanceof Error ? e.message : String(e) })

/** The Mailbox over the control cell (celld dev; Postgres replaces it in k8s). */
export const controlMailbox = (control: DurableObjectNamespace<ControlRpc>): Mailbox["Service"] => {
  const stub = () => control.getByName("control")
  return {
    record: (summary) => Effect.tryPromise({ try: () => stub().record(summary), catch: storageError }),
    list: Effect.tryPromise({ try: () => stub().list(), catch: storageError })
  }
}
