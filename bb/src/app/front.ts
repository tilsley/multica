import { Effect, Schema } from "effect"
import { TaskRequest } from "../domain/index.ts"
import { CellDirectory, CellRejected } from "../ports/index.ts"

// The front door: validates requests, resolves retry lineage and aliases, and
// routes to the right cell (docs/domain.md, "Lineage").

export const submit = Effect.fn("front.submit")(function* (taskId: string, body: unknown) {
  const directory = yield* CellDirectory
  const request = yield* Schema.decodeUnknownEffect(TaskRequest)(body).pipe(
    Effect.mapError((e) => new CellRejected({ status: 400, reason: `invalid task: ${e.message}` }))
  )
  if (request.taskId !== taskId) {
    return yield* new CellRejected({ status: 400, reason: `body taskId ${request.taskId} does not match path ${taskId}` })
  }
  const parentRunId =
    request.retryOf !== undefined && request.retryOf !== taskId
      ? yield* directory.cell(request.retryOf).resolve
      : undefined
  const result = yield* directory.cell(taskId).put(request, parentRunId)
  if (result.taskId === taskId) return result
  // Aliased: answer with the run's own state so the caller can reattach.
  const run = yield* directory.cell(result.taskId).describe
  return { ...run, created: false }
})

const runCell = Effect.fnUntraced(function* (taskId: string) {
  const directory = yield* CellDirectory
  const runId = yield* directory.cell(taskId).resolve
  if (runId === undefined) return yield* new CellRejected({ status: 404, reason: `unknown task ${taskId}` })
  return directory.cell(runId)
})

export const events = Effect.fn("front.events")(function* (taskId: string, since: number) {
  const cell = yield* runCell(taskId)
  return yield* cell.events(since)
})

export const cancel = Effect.fn("front.cancel")(function* (taskId: string) {
  const directory = yield* CellDirectory
  const result = yield* directory.cell(taskId).cancel
  if (result._tag !== "IsAlias") return result
  return yield* directory.cell(result.runId).cancel
})
