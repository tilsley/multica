import { Effect, Schema } from "effect"
import { absent, AgentEvent, type LogEntry, Task } from "../../domain/index.ts"
import { type CellStore, type Scheduler, StorageError } from "../../ports/index.ts"
import type { DurableObjectState } from "./types.ts"

// CellStore and Scheduler over one Durable Object: its SQLite holds the task row
// and the run's log; its alarm drives the run. celld acknowledges a response only
// once the writes it can reveal are durable (its output gate), so a committed
// entry an SSE client has seen can never be lost.

const schema = [
  "CREATE TABLE IF NOT EXISTS task (k INTEGER PRIMARY KEY CHECK (k = 1), body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)"
]

// Rows are decoded on the way out: a stored row that no longer matches the schema
// is a storage error, not a silent cast.
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(AgentEvent))
const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(Task))

const storageError = (e: unknown) => new StorageError({ reason: e instanceof Error ? e.message : String(e) })

export const makeDurableCell = (state: DurableObjectState, taskId: string) => {
  const { storage } = state
  for (const statement of schema) storage.sql.exec(statement)
  let waiters: Array<() => void> = []

  const store: CellStore["Service"] = {
    load: Effect.try({
      try: (): Task => {
        const row = storage.sql.exec<{ body: string }>("SELECT body FROM task WHERE k = 1").toArray()[0]
        return row ? decodeTask(row.body) : absent(taskId)
      },
      catch: storageError
    }),
    commit: (task, appended) =>
      Effect.try({
        try: () =>
          storage.transactionSync(() => {
            storage.sql.exec(
              "INSERT INTO task (k, body) VALUES (1, ?) ON CONFLICT (k) DO UPDATE SET body = excluded.body",
              JSON.stringify(task)
            )
            for (const entry of appended) {
              const { id, at, ...event } = entry
              storage.sql.exec("INSERT INTO log (seq, at, body) VALUES (?, ?, ?)", id, at, JSON.stringify(event))
            }
          }),
        catch: storageError
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (appended.length === 0) return
            const wake = waiters
            waiters = []
            for (const w of wake) w()
          })
        )
      ),
    readLog: (afterSeq, limit) =>
      Effect.try({
        try: () =>
          storage.sql
            .exec<{ seq: number; at: number; body: string }>(
              "SELECT seq, at, body FROM log WHERE seq > ? ORDER BY seq LIMIT ?",
              afterSeq,
              limit
            )
            .toArray()
            .map((row): LogEntry => Object.assign(decodeEvent(row.body), { id: row.seq, at: row.at })),
        catch: storageError
      }),
    awaitAppend: (afterSeq, timeoutMs) =>
      Effect.callback<void>((resume) => {
        const last = storage.sql.exec<{ seq: number | null }>("SELECT max(seq) AS seq FROM log").toArray()[0]?.seq ?? 0
        if (last > afterSeq) {
          resume(Effect.void)
          return
        }
        const w = () => resume(Effect.void)
        waiters.push(w)
        return Effect.sync(() => {
          waiters = waiters.filter((x) => x !== w)
        })
      }).pipe(Effect.timeoutOption(timeoutMs), Effect.asVoid)
  }

  const scheduler: Scheduler["Service"] = {
    wakeIn: (delayMs) =>
      Effect.tryPromise({ try: () => storage.setAlarm(Date.now() + delayMs), catch: storageError }),
    cancel: Effect.tryPromise({ try: () => storage.deleteAlarm(), catch: storageError })
  }

  return { store, scheduler }
}
