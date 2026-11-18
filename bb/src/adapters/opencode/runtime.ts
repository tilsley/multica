import type { OpenCode } from "@opencode/sdk/effect"
import { Clock, Effect, Schema, Stream } from "effect"
import type { AgentEvent } from "../../domain/index.ts"
import { type AgentRuntime, RuntimeError, type Sandboxes, type SandboxError } from "../../ports/index.ts"
import { initialState, mapLog, MapState, promptStart } from "./events.ts"
import * as Id from "./ids.ts"
import { providerName } from "./workspace.ts"

// AgentRuntime over an embedded OpenCode host (the Effect SDK): @opencode/sdk's
// workerd profile inside a session cell in production, the Bun profile in tests.
//
// One bb run = one prompt into an OpenCode session:
//   start     with sandboxes: open the conversation's workspace (clone, claim a
//             sandbox, copy in) and register it with OpenCode, so every tool runs
//             in the sandbox. Ensure session ses_bb_<…> exists (located in that
//             workspace) and send the prompt msg_bb_<runId> unless the durable log
//             already has it (OpenCode would run a repeated id again). The cursor
//             starts just before this run's prompt, so a reply's run reports only
//             its own events.
//   progress  read the durable log after the cursor and map it (events.ts). While
//             OpenCode is working but quiet, heartbeats. When the run ends, copy
//             the sandbox's changes back to bb's copy and report them before the
//             result.
//   cancel    interrupt the session.

export interface OpenCodeRuntimeOptions {
  /** The host. A function so a cell can create it lazily (and again after eviction). */
  readonly host: () => Promise<OpenCode.Interface>
  readonly model: { readonly providerID: string; readonly id: string }
  /** Where sessions are located without a sandbox. */
  readonly directory: string
  readonly heartbeatEveryMs: number
  /** Run every session in a sandbox (the host must register `sandboxWorkspaceProvider`). */
  readonly sandboxes?: Sandboxes["Service"] | undefined
}

const Cursor = Schema.Struct({
  sessionId: Schema.String,
  beat: Schema.Finite,
  map: MapState,
  /** The sandbox workspace, when the run has one. */
  workspace: Schema.optionalKey(Schema.String)
})
type Cursor = typeof Cursor.Type
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))

/** Prompt ids must start with "msg"; derive a stable one per run. */
export const promptIdFor = (runId: string) => `msg_bb_${runId}`

/** One workspace per conversation, named after the session. */
export const workspaceKeyFor = (sessionId: string) => `wrk_${sessionId.replace(/^ses_/, "").replace(/[^A-Za-z0-9_-]/g, "-")}`

const runtimeError = (retryable: boolean) => (e: unknown) =>
  new RuntimeError({
    reason: typeof e === "object" && e !== null && "reason" in e && typeof e.reason === "string" ? e.reason : e instanceof Error ? e.message || String(e) : String(e),
    retryable
  })

const sandboxError = (e: SandboxError) => new RuntimeError({ reason: `sandbox: ${e.reason}`, retryable: e.retryable })

/** The Multica brief (system prompt) travels with the prompt: OpenCode has no per-turn system field. */
const promptText = (prompt: string, systemPrompt: string | undefined) =>
  systemPrompt ? `<multica-runtime-brief>\n${systemPrompt}\n</multica-runtime-brief>\n\n${prompt}` : prompt

const lastSeq = (items: ReadonlyArray<unknown>) => mapLog(items, initialState(0)).state.seq

/** After the run: the sandbox's changes go back to bb's copy, and are reported. */
const finish = (sandboxes: Sandboxes["Service"], key: string) =>
  sandboxes.sync(key).pipe(
    Effect.map(({ changed }): ReadonlyArray<AgentEvent> =>
      changed.length === 0 ? [] : [{ kind: "text", text: `Changed in the workspace: ${changed.join(", ")}` }]
    ),
    Effect.mapError(sandboxError)
  )

export const makeOpenCodeRuntime = (options: OpenCodeRuntimeOptions): AgentRuntime["Service"] => {
  const host = Effect.tryPromise({ try: options.host, catch: runtimeError(true) })
  const withHost = <A, E>(f: (oc: OpenCode.Interface) => Effect.Effect<A, E>) =>
    host.pipe(Effect.flatMap((oc) => f(oc).pipe(Effect.mapError(runtimeError(true)))))

  const readLog = (sessionId: string, after: number) =>
    Effect.all([Id.sessionID(sessionId), Id.seq(after)]).pipe(
      Effect.flatMap(([sessionID, from]) =>
        withHost((oc) => Stream.runCollect(oc.experimental.session.log({ sessionID, after: from, follow: false })))
      )
    )

  /** Opens the conversation's workspace and registers it with OpenCode; returns its root. */
  const openWorkspace = (sandboxes: Sandboxes["Service"], key: string, repos: ReadonlyArray<{ readonly url: string; readonly ref?: string | undefined }>) =>
    Effect.gen(function* () {
      const { root } = yield* sandboxes.open({ key, repos }).pipe(Effect.mapError(sandboxError))
      const id = yield* Id.workspaceID(key)
      yield* withHost((oc) => oc.workspace.create({ id, provider: providerName }))
      yield* withHost((oc) => oc.workspace.provision({ workspaceID: id }))
      return root
    })

  return {
    start: ({ runId, sessionId, request }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const sessionID = yield* Id.sessionID(sessionId)
        const promptId = yield* Id.messageID(promptIdFor(runId))
        const workspace = options.sandboxes ? workspaceKeyFor(sessionId) : undefined
        const root = yield* Id.absolutePath(
          options.sandboxes && workspace ? yield* openWorkspace(options.sandboxes, workspace, request.repos ?? []) : options.directory
        )
        const location = workspace ? { directory: root, workspaceID: yield* Id.workspaceID(workspace) } : { directory: root }
        const model = yield* Id.modelRef(options.model)
        const exists = yield* withHost((oc) => oc.sessions.get({ sessionID })).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
        if (!exists) {
          yield* withHost((oc) =>
            oc.sessions.create({
              id: sessionID,
              title: request.issue?.identifier ?? request.taskId,
              model,
              location
            })
          )
        }
        // Idempotent and crash-safe: if this run's prompt is already in the log, do
        // not send it again, and start the cursor just before it. Otherwise the
        // cursor starts at the log's end (earlier turns are not this run's events).
        const log = yield* readLog(sessionId, 0)
        const sent = promptStart(log, promptId)
        const before = sent ?? lastSeq(log)
        if (sent === undefined) {
          yield* withHost((oc) =>
            oc.sessions.prompt({ sessionID, id: promptId, text: promptText(request.prompt, request.systemPrompt) })
          )
        }
        const cursor: Cursor = { sessionId, beat: now, map: initialState(before), ...(workspace ? { workspace } : {}) }
        return JSON.stringify(cursor)
      }),

    progress: (_runId, raw) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const cursor = yield* decodeCursor(raw).pipe(Effect.mapError(runtimeError(false)))
        const items = yield* readLog(cursor.sessionId, cursor.map.seq)
        const mapped = mapLog(items, cursor.map)
        let events: Array<AgentEvent> = [...mapped.events]
        const resultAt = events.findIndex((e) => e.kind === "result")
        if (resultAt >= 0 && options.sandboxes && cursor.workspace) {
          // If the sync fails the whole batch is retried next tick (the cursor does
          // not advance), so the result is never reported before the changes are back.
          const changes = yield* finish(options.sandboxes, cursor.workspace)
          events = [...events.slice(0, resultAt), ...changes, ...events.slice(resultAt)]
        }
        let beat = events.length > 0 ? now : cursor.beat
        if (events.length === 0 && !mapped.state.done && now - cursor.beat >= options.heartbeatEveryMs) {
          const active = yield* withHost((oc) => oc.sessions.active())
          if (cursor.sessionId in active) {
            events.push({ kind: "heartbeat" })
            beat = now
          }
        }
        const next: Cursor = { ...cursor, beat, map: mapped.state }
        return { events, cursor: JSON.stringify(next) }
      }),

    cancel: ({ sessionId }) =>
      Id.sessionID(sessionId).pipe(
        Effect.flatMap((sessionID) => withHost((oc) => oc.sessions.interrupt({ sessionID }))),
        Effect.asVoid
      )
  }
}
