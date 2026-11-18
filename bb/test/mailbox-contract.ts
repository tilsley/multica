import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { Mailbox, TaskSummary } from "../src/ports/index.ts"

const summary = (taskId: string, over: Partial<TaskSummary> = {}): TaskSummary => ({
  taskId,
  runId: taskId,
  state: "Run",
  status: "running",
  sessionId: `s-${taskId}`,
  issue: "BB-1",
  resumedFrom: undefined,
  eventCount: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over
})

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

/** Every Mailbox adapter passes this. `prefix` isolates a run's rows in a shared database. */
export const mailboxContract = (name: string, make: () => Mailbox["Service"], prefix: string) => {
  const mine = (rows: ReadonlyArray<TaskSummary>) => rows.filter((r) => r.taskId.startsWith(prefix))
  describe(`Mailbox contract: ${name}`, () => {

    it("records and lists summaries in creation order, with optional fields round-tripping", async () => {
      const m = make()
      await run(m.record(summary(`${prefix}b`, { createdAt: 2_000, updatedAt: 2_000 })))
      await run(m.record(summary(`${prefix}a`, { resumedFrom: "s-old" })))
      await run(m.record(summary(`${prefix}c`, { state: "Alias", runId: `${prefix}a`, status: undefined, sessionId: undefined, issue: undefined, createdAt: 3_000, updatedAt: 3_000 })))
      const rows = mine(await run(m.list))
      expect(rows.map((r) => r.taskId)).toEqual([`${prefix}a`, `${prefix}b`, `${prefix}c`])
      expect(rows[0]).toEqual(summary(`${prefix}a`, { resumedFrom: "s-old" }))
      expect(rows[2]).toMatchObject({ state: "Alias", runId: `${prefix}a`, status: undefined, issue: undefined })
    })

    it("upserts by task id and keeps the first creation time", async () => {
      const m = make()
      await run(m.record(summary(`${prefix}u`)))
      await run(m.record(summary(`${prefix}u`, { status: "succeeded", eventCount: 9, createdAt: 5_000, updatedAt: 6_000 })))
      const row = mine(await run(m.list)).find((r) => r.taskId === `${prefix}u`)
      expect(row).toMatchObject({ status: "succeeded", eventCount: 9, createdAt: 1_000, updatedAt: 6_000 })
    })

    it("a stale write never overwrites a newer one (isolates can index out of order)", async () => {
      const m = make()
      await run(m.record(summary(`${prefix}o`, { status: "succeeded", eventCount: 9, updatedAt: 9_000 })))
      await run(m.record(summary(`${prefix}o`, { status: "running", eventCount: 3, updatedAt: 4_000 })))
      const row = mine(await run(m.list)).find((r) => r.taskId === `${prefix}o`)
      expect(row).toMatchObject({ status: "succeeded", eventCount: 9 })
    })
  })
}
