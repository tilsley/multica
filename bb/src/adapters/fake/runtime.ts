import { Clock, Effect, Schema } from "effect"
import type { AgentEvent } from "../../domain/index.ts"
import { RuntimeError, type AgentRuntime } from "../../ports/index.ts"

// A scripted coding agent. Its output is a pure function of (script, start time,
// now), carried in the cursor, so a cell that is evicted and restarted resumes
// exactly where it was. The script is captured when the run starts: changing it
// later only affects new runs.

export interface Script {
  readonly stepDelayMs: number
  readonly steps: number
  readonly heartbeatEveryMs: number
  /** After the first event, the agent goes quiet (no events, no heartbeats) this long. */
  readonly silentForMs: number
  readonly resultStatus: "succeeded" | "failed"
}

export const defaultScript: Script = {
  stepDelayMs: 1000,
  steps: 8,
  heartbeatEveryMs: 2000,
  silentForMs: 0,
  resultStatus: "succeeded"
}

const Cursor = Schema.Struct({
  start: Schema.Finite,
  emitted: Schema.Int,
  lastBeat: Schema.Finite,
  resumed: Schema.String,
  script: Schema.Struct({
    stepDelayMs: Schema.Finite,
    steps: Schema.Int,
    heartbeatEveryMs: Schema.Finite,
    silentForMs: Schema.Finite,
    resultStatus: Schema.Literals(["succeeded", "failed"])
  })
})
type Cursor = typeof Cursor.Type
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))

/** Event n (1-based) of the script, plus a final result. Mirrors mock-bb's agent. */
const step = (n: number, cursor: Cursor, runId: string): ReadonlyArray<AgentEvent> => {
  if (n === 0) {
    return [{ kind: "thought", text: cursor.resumed !== "" ? `Resuming session ${cursor.resumed}; reading the issue.` : "Starting; reading the issue and planning." }]
  }
  if (n > cursor.script.steps) {
    return cursor.script.resultStatus === "succeeded"
      ? [{ kind: "result", status: "succeeded", summary: `bb (scripted) completed the task in ${cursor.script.steps} steps.`, prUrl: `https://github.com/example/repo/pull/${1000 + (runId.length % 97)}` }]
      : [{ kind: "result", status: "failed", error: "bb (scripted): simulated failure" }]
  }
  switch (n % 3) {
    case 1:
      return [
        { kind: "tool_call", phase: "start", callId: `call-${n}`, tool: "bash", input: { command: `step ${n}` } },
        { kind: "tool_call", phase: "end", callId: `call-${n}`, tool: "bash", output: "ok" }
      ]
    case 2:
      return [{ kind: "thought", text: `Considering step ${n}.` }]
    default:
      return [{ kind: "text", text: `Finished step ${n}. ` }]
  }
}

export interface ScriptedRuntimeControl {
  script: Script
  readonly started: Array<string>
  readonly cancelled: Array<string>
  /** Fail calls with a retryable error while set (an unreachable runtime). */
  unavailable: boolean
}

export const makeScriptedRuntime = (initial: Script = defaultScript) => {
  const control: ScriptedRuntimeControl = { script: initial, started: [], cancelled: [], unavailable: false }
  const down = Effect.suspend(() =>
    control.unavailable ? Effect.fail(new RuntimeError({ reason: "scripted runtime unavailable", retryable: true })) : Effect.void
  )

  const service: AgentRuntime["Service"] = {
    start: ({ runId, request }) =>
      Effect.gen(function* () {
        yield* down
        const now = yield* Clock.currentTimeMillis
        if (!control.started.includes(runId)) control.started.push(runId)
        const cursor: Cursor = { start: now, emitted: -1, lastBeat: now, resumed: request.resumeSessionId ?? "", script: control.script }
        return JSON.stringify(cursor)
      }),
    cancel: (runId) => Effect.sync(() => void control.cancelled.push(runId)),
    progress: (runId, raw) =>
      Effect.gen(function* () {
        yield* down
        const now = yield* Clock.currentTimeMillis
        const cursor = yield* decodeCursor(raw).pipe(
          Effect.mapError((e) => new RuntimeError({ reason: `bad cursor: ${e.message}`, retryable: false }))
        )
        const { stepDelayMs, steps, heartbeatEveryMs, silentForMs } = cursor.script
        const events: Array<AgentEvent> = []
        let emitted = cursor.emitted
        let lastBeat = cursor.lastBeat
        // Step 0 is immediate; step n is due at start + silence + n * delay.
        const due = (n: number) => (n === 0 ? cursor.start : cursor.start + silentForMs + n * stepDelayMs)
        while (emitted < steps + 1 && due(emitted + 1) <= now) {
          emitted++
          events.push(...step(emitted, cursor, runId))
          lastBeat = now
        }
        const silent = now < cursor.start + silentForMs
        if (events.length === 0 && !silent && heartbeatEveryMs > 0 && now - lastBeat >= heartbeatEveryMs) {
          events.push({ kind: "heartbeat" })
          lastBeat = now
        }
        return { events, cursor: JSON.stringify({ ...cursor, emitted, lastBeat }) }
      })
  }
  return { service, control }
}
