import { Effect } from "effect"
import type { Mailbox, TaskSummary } from "../../ports/index.ts"

export const makeMemoryMailbox = () => {
  const rows = new Map<string, TaskSummary>()
  const service: Mailbox["Service"] = {
    record: (summary) => Effect.sync(() => void rows.set(summary.taskId, summary)),
    list: Effect.sync(() => [...rows.values()].toSorted((a, b) => a.createdAt - b.createdAt))
  }
  return { service, rows }
}
