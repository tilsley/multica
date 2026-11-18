import { Effect } from "effect"
import postgres from "postgres"
import { type Mailbox, StorageError, type TaskSummary } from "../../ports/index.ts"

// The mailbox index in Postgres. Cells stay the source of truth: this table is
// written after each cell commit and can lag by up to CellSettings.indexEveryMs
// for a running task's event count (never for a state change).

const migrations = [
  `CREATE TABLE IF NOT EXISTS bb_task (
     task_id      text PRIMARY KEY,
     run_id       text,
     state        text NOT NULL,
     status       text,
     session_id   text,
     issue        text,
     resumed_from text,
     event_count  integer NOT NULL DEFAULT 0,
     created_at   timestamptz NOT NULL,
     updated_at   timestamptz NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS bb_task_run_id ON bb_task (run_id)`,
  `CREATE INDEX IF NOT EXISTS bb_task_issue ON bb_task (issue)`
]

interface Row {
  task_id: string
  run_id: string | null
  state: TaskSummary["state"]
  status: string | null
  session_id: string | null
  issue: string | null
  resumed_from: string | null
  event_count: number
  created_at: Date
  updated_at: Date
}

const opt = (v: string | null) => v ?? undefined
const storageError = (e: unknown) => new StorageError({ reason: e instanceof Error ? e.message : String(e) })

type Sql = ReturnType<typeof postgres>

export interface PostgresMailboxOptions {
  /**
   * "pooled" keeps one lazily-opened connection (Bun, tests). "per-operation"
   * connects, queries and closes each time: required in workerd/celld, where a
   * socket may only be used by the event (request or alarm) that opened it.
   */
  readonly mode: "pooled" | "per-operation"
}

export const makePostgresMailbox = (url: string, options: PostgresMailboxOptions = { mode: "pooled" }) => {
  const open = () => postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} })
  const pooled = options.mode === "pooled" ? open() : undefined
  let migrated = false
  // One multi-statement simple query, so the statements apply in order.
  const migrate = async (sql: Sql) => {
    if (migrated) return
    await sql.unsafe(migrations.join(";\n"))
    migrated = true
  }
  const withSql = async <A>(f: (sql: Sql) => Promise<A>): Promise<A> => {
    const sql = pooled ?? open()
    try {
      await migrate(sql)
      return await f(sql)
    } finally {
      if (!pooled) await sql.end({ timeout: 1 })
    }
  }
  const q = <A>(f: (sql: Sql) => Promise<A>) => Effect.tryPromise({ try: () => withSql(f), catch: storageError })

  const service: Mailbox["Service"] = {
    record: (s) =>
      q(
        (sql) => sql`
          INSERT INTO bb_task (task_id, run_id, state, status, session_id, issue, resumed_from, event_count, created_at, updated_at)
          VALUES (${s.taskId}, ${s.runId ?? null}, ${s.state}, ${s.status ?? null}, ${s.sessionId ?? null}, ${s.issue ?? null},
                  ${s.resumedFrom ?? null}, ${s.eventCount}, ${new Date(s.createdAt)}, ${new Date(s.updatedAt)})
          ON CONFLICT (task_id) DO UPDATE SET
            run_id = excluded.run_id, state = excluded.state, status = excluded.status, session_id = excluded.session_id,
            issue = excluded.issue, resumed_from = excluded.resumed_from, event_count = excluded.event_count,
            updated_at = excluded.updated_at
          WHERE bb_task.updated_at <= excluded.updated_at`
      ).pipe(Effect.asVoid),
    list: q((sql) => sql<Array<Row>>`SELECT * FROM bb_task ORDER BY created_at, task_id`).pipe(
      Effect.map((rows) =>
        rows.map((r): TaskSummary => ({
          taskId: r.task_id,
          runId: opt(r.run_id),
          state: r.state,
          status: opt(r.status),
          sessionId: opt(r.session_id),
          issue: opt(r.issue),
          resumedFrom: opt(r.resumed_from),
          eventCount: r.event_count,
          createdAt: r.created_at.getTime(),
          updatedAt: r.updated_at.getTime()
        }))
      )
    )
  }
  return {
    service,
    /** Test mode only (/admin/reset). */
    truncate: () => withSql((sql) => sql`TRUNCATE bb_task`).then(() => undefined),
    end: () => (pooled ? pooled.end({ timeout: 1 }) : Promise.resolve())
  }
}
