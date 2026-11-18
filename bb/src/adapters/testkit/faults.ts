import { Schema } from "effect"
import { defaultScript, type Script } from "../fake/runtime.ts"
import type { TaskSummary } from "../../ports/index.ts"

// Test-only tooling, enabled with BB_TEST_ADMIN=1: the same failure switches and
// /admin endpoints as mock-bb, so the Go contract test and the Multica compose
// drills run unchanged against real bb. Never enable it in production.

const Duration = Schema.Union([Schema.String, Schema.Finite])

/** mock-bb's /admin/config body. Durations are Go-style strings ("1500ms") or milliseconds. */
export const TestConfig = Schema.Struct({
  failFirst: Schema.optionalKey(Schema.Int),
  failFor: Schema.optionalKey(Duration),
  acceptThenDrop: Schema.optionalKey(Schema.Int),
  dropAfter: Schema.optionalKey(Schema.Int),
  silentFor: Schema.optionalKey(Duration),
  stepDelay: Schema.optionalKey(Duration),
  resultAfter: Schema.optionalKey(Schema.Int),
  heartbeatEvery: Schema.optionalKey(Duration),
  resultStatus: Schema.optionalKey(Schema.Literals(["succeeded", "failed"])),
  duplicatePut: Schema.optionalKey(Schema.Boolean)
})
export type TestConfig = typeof TestConfig.Type

export const decodeTestConfig = Schema.decodeUnknownSync(TestConfig)

const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Parses "1500ms", "2s", "1m30s", "0s" or a number of milliseconds. */
export const toMs = (d: string | number | undefined): number => {
  if (d === undefined) return 0
  if (typeof d === "number") return d
  let total = 0
  for (const m of d.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(m[1]) * (units[m[2] ?? "ms"] ?? 1)
  return total
}

export interface FaultState {
  readonly config: TestConfig
  /** Non-admin requests seen since failFirst was last set. */
  readonly requests: number
  /** When failFor ends (epoch ms), 0 for none. */
  readonly failUntil: number
  /** PUTs still to accept-then-drop. */
  readonly dropsLeft: number
}

export const initialFaults: FaultState = { config: {}, requests: 0, failUntil: 0, dropsLeft: 0 }

export const applyConfig = (state: FaultState, patch: TestConfig, now: number): FaultState => {
  const config = { ...state.config, ...patch }
  return {
    config,
    requests: patch.failFirst !== undefined ? 0 : state.requests,
    failUntil: patch.failFor !== undefined ? (toMs(patch.failFor) > 0 ? now + toMs(patch.failFor) : 0) : state.failUntil,
    dropsLeft: patch.acceptThenDrop ?? state.dropsLeft
  }
}

export const scriptOf = (config: TestConfig): Script => ({
  stepDelayMs: config.stepDelay !== undefined ? toMs(config.stepDelay) : defaultScript.stepDelayMs,
  steps: config.resultAfter ?? defaultScript.steps,
  heartbeatEveryMs: config.heartbeatEvery !== undefined ? toMs(config.heartbeatEvery) : defaultScript.heartbeatEveryMs,
  silentForMs: toMs(config.silentFor),
  resultStatus: config.resultStatus ?? defaultScript.resultStatus
})

/** One request's verdict: refuse with 503, or pass (and maybe drop the PUT reply / cut the stream). */
export type Verdict = { readonly _tag: "Fail" } | { readonly _tag: "Pass"; readonly dropReply: boolean; readonly dropAfter: number }

export const judge = (state: FaultState, isPut: boolean, now: number): { readonly next: FaultState; readonly verdict: Verdict } => {
  const requests = state.requests + 1
  const failing = requests <= (state.config.failFirst ?? 0) || now < state.failUntil
  if (failing) return { next: { ...state, requests }, verdict: { _tag: "Fail" } }
  const dropReply = isPut && state.dropsLeft > 0
  return {
    next: { ...state, requests, dropsLeft: dropReply ? state.dropsLeft - 1 : state.dropsLeft },
    verdict: { _tag: "Pass", dropReply, dropAfter: state.config.dropAfter ?? 0 }
  }
}

/** Cuts an SSE byte stream after `n` frames unless the frame is the result (mock-bb's dropAfter). */
export const cutAfter = (body: ReadableStream<Uint8Array>, n: number): ReadableStream<Uint8Array> => {
  if (n <= 0) return body
  const decoder = new TextDecoder()
  let frames = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        const text = decoder.decode(chunk, { stream: true })
        for (const frame of text.split("\n\n")) {
          if (!frame.startsWith("id: ")) continue
          frames++
          if (frames >= n && !frame.includes("\nevent: result\n")) controller.terminate()
        }
      }
    })
  )
}

/** A body that fails mid-read: the client sees a dropped connection after the server committed. */
export const brokenBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("connection dropped (test fault)"))
    }
  })

/** mock-bb's GET /admin/state, built from the mailbox index. */
export const adminState = (rows: ReadonlyArray<TaskSummary>, config: TestConfig) => {
  const ordered = rows.toSorted((a, b) => a.createdAt - b.createdAt)
  const runs = ordered.filter((r) => r.state === "Run")
  const aliases = Object.fromEntries(ordered.filter((r) => r.state === "Alias").map((r) => [r.taskId, r.runId ?? ""]))
  return {
    runsStarted: runs.length,
    tasks: runs.map((r) => ({
      id: r.taskId,
      sessionId: r.sessionId ?? "",
      status: r.status ?? "running",
      aliases: Object.entries(aliases).filter(([, run]) => run === r.taskId).map(([alias]) => alias),
      issue: r.issue ?? "",
      resumedFrom: r.resumedFrom ?? null,
      eventCount: r.eventCount,
      createdAt: new Date(r.createdAt).toISOString()
    })),
    aliases,
    tombstones: Object.fromEntries(ordered.filter((r) => r.state === "Tombstone").map((r) => [r.taskId, true])),
    config
  }
}
