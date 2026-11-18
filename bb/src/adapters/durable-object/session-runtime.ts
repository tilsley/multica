import { Effect, Schema } from "effect"
import { type AgentRuntime, RuntimeError, type RuntimeProgress, type RuntimeStart } from "../../ports/index.ts"
import type { DurableObjectNamespace } from "./types.ts"

// AgentRuntime for a task cell whose agent lives in a SESSION cell: one Durable
// Object per OpenCode session (idFromName(sessionId)). A reply in Multica is a new
// task carrying the previous session id, so the conversation's history must live
// with the session, not with any one task. The task cell's cursor wraps the
// session cell's own cursor with the session id, so progress and cancel find it.

export type RuntimeOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean }

export interface SessionCellRpc {
  start(input: RuntimeStart): Promise<RuntimeOutcome<string>>
  progress(runId: string, cursor: string): Promise<RuntimeOutcome<RuntimeProgress>>
  cancel(input: { readonly runId: string; readonly sessionId: string }): Promise<RuntimeOutcome<void>>
}

const Wrapped = Schema.Struct({ sessionId: Schema.String, inner: Schema.String })
const decodeWrapped = Schema.decodeUnknownEffect(Schema.fromJsonString(Wrapped))

const call = <A>(f: () => Promise<RuntimeOutcome<A>>): Effect.Effect<A, RuntimeError> =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new RuntimeError({ reason: `session cell unreachable: ${e instanceof Error ? e.message : String(e)}`, retryable: true })
  }).pipe(
    Effect.flatMap((o): Effect.Effect<A, RuntimeError> =>
      o.ok ? Effect.succeed(o.value) : Effect.fail(new RuntimeError({ reason: o.reason, retryable: o.retryable }))
    )
  )

export const sessionCellRuntime = (sessions: DurableObjectNamespace<SessionCellRpc>): AgentRuntime["Service"] => ({
  start: (input) =>
    call(() => sessions.getByName(input.sessionId).start(input)).pipe(
      Effect.map((inner) => JSON.stringify({ sessionId: input.sessionId, inner }))
    ),
  progress: (runId, raw) =>
    Effect.gen(function* () {
      const cursor = yield* decodeWrapped(raw).pipe(
        Effect.mapError((e) => new RuntimeError({ reason: `bad cursor: ${e.message}`, retryable: false }))
      )
      const progress = yield* call(() => sessions.getByName(cursor.sessionId).progress(runId, cursor.inner))
      return { events: progress.events, cursor: JSON.stringify({ sessionId: cursor.sessionId, inner: progress.cursor }) }
    }),
  cancel: (input) => call(() => sessions.getByName(input.sessionId).cancel(input))
})

/** The session cell's side: runs an AgentRuntime and answers RPC as plain data. */
const answer = <A>(effect: Effect.Effect<A, RuntimeError>): Promise<RuntimeOutcome<A>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value): RuntimeOutcome<A> => ({ ok: true, value })),
      Effect.catch((e) => Effect.succeed<RuntimeOutcome<A>>({ ok: false, reason: e.reason, retryable: e.retryable }))
    )
  )

export const serveRuntime = (runtime: AgentRuntime["Service"]): SessionCellRpc => {
  const run = answer
  return {
    start: (input) => run(runtime.start(input)),
    progress: (runId, cursor) => run(runtime.progress(runId, cursor)),
    cancel: (input) => run(runtime.cancel(input))
  }
}
