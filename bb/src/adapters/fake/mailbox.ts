import { Effect } from "effect"
import type { Mailbox, TaskSummary } from "../../ports/index.ts"

export const makeMemoryMailbox = () => {
  const rows = new Map<string, TaskSummary>()
  const service: Mailbox["Service"] = {
    record: (summary) =>
      Effect.sync(() => {
        const prior = rows.get(summary.taskId)
        // Same rules as Postgres: keep the first creation time; a stale write never wins.
        if (prior && prior.updatedAt > summary.updatedAt) return
        rows.set(summary.taskId, prior ? { ...summary, createdAt: prior.createdAt } : summary)
      }),
    list: Effect.sync(() => [...rows.values()].toSorted((a, b) => a.createdAt - b.createdAt))
  }
  return { service, rows }
}
