import { Effect } from "effect"
import { absent, type LogEntry, type Task } from "../../domain/index.ts"
import type { CellStore } from "../../ports/index.ts"

/** In-memory storage for one cell. Durable for the life of the process. */
export const makeMemoryCellStore = (taskId: string) => {
  let task: Task = absent(taskId)
  const log: Array<LogEntry> = []
  let waiters: Array<() => void> = []

  const service: CellStore["Service"] = {
    load: Effect.sync(() => task),
    commit: (next, appended) =>
      Effect.sync(() => {
        task = next
        log.push(...appended)
        if (appended.length > 0) {
          const wake = waiters
          waiters = []
          for (const w of wake) w()
        }
      }),
    readLog: (afterSeq, limit) => Effect.sync(() => log.filter((e) => e.id > afterSeq).slice(0, limit)),
    awaitAppend: (afterSeq, timeoutMs) =>
      Effect.callback<void>((resume) => {
        if ((log.at(-1)?.id ?? 0) > afterSeq) {
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
  return { service, snapshot: () => ({ task, log: [...log] }) }
}
