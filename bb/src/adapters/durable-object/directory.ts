import { Effect } from "effect"
import type { TaskRequest } from "../../domain/index.ts"
import {
  type CancelResult,
  type CellClient,
  type CellDirectory,
  type CellError,
  CellRejected,
  CellUnavailable,
  type PutResult
} from "../../ports/index.ts"
import type { DurableObjectNamespace } from "./types.ts"

// CellDirectory over the TASKS Durable Object namespace. Calls cross nodes as RPC,
// so results travel as plain data: an Outcome instead of a thrown error.

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly status: 400 | 404 | 409 | 422 | 503; readonly reason: string }

export interface TaskCellRpc {
  put(request: TaskRequest, parentRunId: string | undefined): Promise<Outcome<PutResult>>
  describe(): Promise<Outcome<PutResult>>
  resolve(): Promise<Outcome<string | undefined>>
  cancel(): Promise<Outcome<CancelResult>>
  fetch(request: Request): Promise<Response>
}

const call = <A>(f: () => Promise<Outcome<A>>): Effect.Effect<A, CellError> =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new CellUnavailable({ reason: `cell unreachable: ${e instanceof Error ? e.message : String(e)}` })
  }).pipe(
    Effect.flatMap((o): Effect.Effect<A, CellError> => {
      if (o.ok) return Effect.succeed(o.value)
      return o.status === 503
        ? Effect.fail(new CellUnavailable({ reason: o.reason }))
        : Effect.fail(new CellRejected({ status: o.status, reason: o.reason }))
    })
  )

export const durableDirectory = (tasks: DurableObjectNamespace<TaskCellRpc>): CellDirectory["Service"] => ({
  cell: (taskId): CellClient => {
    const stub = () => tasks.getByName(taskId)
    return {
      put: (request, parentRunId) => call(() => stub().put(request, parentRunId)),
      describe: call(() => stub().describe()),
      resolve: call(() => stub().resolve()),
      cancel: call(() => stub().cancel()),
      // Events are a long-lived stream: plain fetch to the cell, which answers SSE.
      events: (since) =>
        Effect.tryPromise({
          try: () => stub().fetch(new Request(`https://cell/events?since=${since}`)),
          catch: (e) => new CellUnavailable({ reason: `cell unreachable: ${e instanceof Error ? e.message : String(e)}` })
        }).pipe(
          Effect.flatMap((res): Effect.Effect<ReadableStream<Uint8Array>, CellError> => {
            if (res.ok && res.body) return Effect.succeed(res.body)
            return Effect.fail(
              res.status === 404
                ? new CellRejected({ status: 404, reason: "no run in this cell" })
                : new CellUnavailable({ reason: `cell answered ${res.status}` })
            )
          })
        )
    }
  }
})
