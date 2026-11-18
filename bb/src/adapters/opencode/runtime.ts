import type { OpenCode } from "@opencode/sdk"
import { Clock, Effect, Schema } from "effect"
import { type AgentRuntime, RuntimeError } from "../../ports/index.ts"
import { initialState, mapLog, MapState, promptStart } from "./events.ts"

// AgentRuntime over an embedded OpenCode host: @opencode/sdk/workerd inside the
// task's Durable Object in production, the Bun host in tests. Both serve the same
// typed client (OpenCode.Interface), so this adapter is written against that.
//
// One bb run = one prompt into an OpenCode session:
//   start     ensure session ses_bb_<…> exists and send the prompt msg_bb_<runId>
//             unless the durable log already has it (OpenCode would run a repeated
//             id again); return a cursor just before this run's prompt, so a
//             reply's run reports only its own events.
//   progress  read the durable log after the cursor and map it (events.ts). While
//             OpenCode is still working but quiet, emit heartbeats.
//   cancel    interrupt the session.

export interface OpenCodeRuntimeOptions {
  /** The host. A function so a cell can create it lazily (and recreate it after eviction). */
  readonly host: () => Promise<OpenCode.Interface>
  readonly model: { readonly providerID: string; readonly id: string }
  /** Working directory OpenCode sessions are located in. */
  readonly directory: string
  readonly heartbeatEveryMs: number
}

const Cursor = Schema.Struct({ sessionId: Schema.String, beat: Schema.Finite, map: MapState })
type Cursor = typeof Cursor.Type
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))

/** Prompt ids must start with "msg"; derive a stable one per run. */
export const promptIdFor = (runId: string) => `msg_bb_${runId}`

const runtimeError = (retryable: boolean) => (e: unknown) =>
  new RuntimeError({ reason: e instanceof Error ? e.message : String(e), retryable })

/** The Multica brief (system prompt) travels with the prompt: OpenCode has no per-turn system field. */
const promptText = (prompt: string, systemPrompt: string | undefined) =>
  systemPrompt ? `<multica-runtime-brief>\n${systemPrompt}\n</multica-runtime-brief>\n\n${prompt}` : prompt

const lastSeq = (items: ReadonlyArray<unknown>) => mapLog(items, initialState(0)).state.seq

export const makeOpenCodeRuntime = (options: OpenCodeRuntimeOptions): AgentRuntime["Service"] => {
  const call = <A>(f: (oc: OpenCode.Interface) => Promise<A>, retryable = true) =>
    Effect.tryPromise({ try: async () => f(await options.host()), catch: runtimeError(retryable) })

  const readLog = (sessionId: string, after: number) =>
    call(async (oc) => {
      const items: Array<unknown> = []
      for await (const item of oc.experimental.session.log({ sessionID: sessionId, after, follow: false })) items.push(item)
      return items
    })

  return {
    start: ({ runId, sessionId, request }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const exists = yield* call((oc) => oc.sessions.get({ sessionID: sessionId })).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
        if (!exists) {
          yield* call((oc) =>
            oc.sessions.create({
              id: sessionId,
              title: request.issue?.identifier ?? request.taskId,
              model: options.model,
              location: { directory: options.directory }
            })
          )
        }
        // Idempotent and crash-safe: if this run's prompt is already in the log, do
        // not send it again, and start the cursor just before it. Otherwise the
        // cursor starts at the log's end (earlier turns are not this run's events).
        const promptId = promptIdFor(runId)
        const log = yield* readLog(sessionId, 0)
        const sent = promptStart(log, promptId)
        const before = sent ?? lastSeq(log)
        if (sent === undefined) {
          yield* call((oc) =>
            oc.sessions.prompt({ sessionID: sessionId, id: promptId, text: promptText(request.prompt, request.systemPrompt) })
          )
        }
        const cursor: Cursor = { sessionId, beat: now, map: initialState(before) }
        return JSON.stringify(cursor)
      }),

    progress: (_runId, raw) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const cursor = yield* decodeCursor(raw).pipe(Effect.mapError(runtimeError(false)))
        const items = yield* readLog(cursor.sessionId, cursor.map.seq)
        const { events, state } = mapLog(items, cursor.map)
        let beat = events.length > 0 ? now : cursor.beat
        if (events.length === 0 && !state.done && now - cursor.beat >= options.heartbeatEveryMs) {
          const active = yield* call((oc) => oc.sessions.active())
          if (cursor.sessionId in active) {
            events.push({ kind: "heartbeat" })
            beat = now
          }
        }
        const next: Cursor = { sessionId: cursor.sessionId, beat, map: state }
        return { events, cursor: JSON.stringify(next) }
      }),

    cancel: ({ sessionId }) => call((oc) => oc.sessions.interrupt({ sessionID: sessionId })).pipe(Effect.asVoid)
  }
}
