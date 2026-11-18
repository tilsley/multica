import { Schema } from "effect"
import type { AgentEvent } from "../../domain/index.ts"

// Maps OpenCode's durable session log (experimental.session.log) to bb contract
// events. Pure: the runtime adapter feeds it log items in order and persists the
// returned state in the cell's cursor, so a cell evicted mid-run resumes exactly.

/** What survives between progress calls (serialized into the runtime cursor). */
export const MapState = Schema.Struct({
  /** Last log seq consumed. */
  seq: Schema.Int,
  /** Tool call id -> tool name (names arrive on tool.input.started, results later). */
  tools: Schema.Record(Schema.String, Schema.String),
  /** The run's latest assistant text: the result summary. */
  lastText: Schema.String,
  /** A terminal event was seen. */
  done: Schema.Boolean
})
export type MapState = typeof MapState.Type

export const initialState = (seq: number): MapState => ({ seq, tools: {}, lastText: "", done: false })

// Only the fields bb reads are decoded; anything else in a log item is ignored.
const Durable = Schema.Struct({ seq: Schema.Int })
const Item = Schema.Struct({
  type: Schema.String,
  durable: Schema.optionalKey(Durable),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})
const decodeItem = Schema.decodeUnknownOption(Item)

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) return ""
  return content
    .map((c: unknown) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : ""))
    .filter((t) => t !== "")
    .join("\n")
}

const errorOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "OpenCode reported an error"

const inputOf = (input: unknown): Record<string, unknown> | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : undefined

/**
 * Folds log items into contract events. Items at or below state.seq are replays
 * and are skipped; nothing is emitted after a terminal event.
 */
export const mapLog = (items: ReadonlyArray<unknown>, state: MapState): { events: Array<AgentEvent>; state: MapState } => {
  const events: Array<AgentEvent> = []
  let { seq, lastText, done } = state
  const tools = { ...state.tools }
  for (const raw of items) {
    const decoded = decodeItem(raw)
    if (decoded._tag === "None") continue
    const item = decoded.value
    const itemSeq = item.durable?.seq
    if (itemSeq === undefined || itemSeq <= seq) continue
    seq = itemSeq
    if (done) continue
    const d = item.data ?? {}
    switch (item.type) {
      case "session.text.ended": {
        const text = str(d["text"]) ?? ""
        if (text !== "") {
          lastText = text
          events.push({ kind: "text", text })
        }
        break
      }
      case "session.reasoning.ended": {
        const text = str(d["text"]) ?? ""
        if (text !== "") events.push({ kind: "thought", text })
        break
      }
      case "session.tool.input.started": {
        const id = str(d["id"])
        const name = str(d["name"])
        if (id && name) tools[id] = name
        break
      }
      case "session.tool.called": {
        const id = str(d["id"]) ?? ""
        const input = inputOf(d["input"])
        events.push({ kind: "tool_call", phase: "start", callId: id, tool: tools[id] ?? "tool", ...(input ? { input } : {}) })
        break
      }
      case "session.tool.success": {
        const id = str(d["id"]) ?? ""
        events.push({ kind: "tool_call", phase: "end", callId: id, tool: tools[id] ?? "tool", output: textOf(d["content"]) })
        break
      }
      case "session.tool.failed": {
        const id = str(d["id"]) ?? ""
        events.push({ kind: "tool_call", phase: "end", callId: id, tool: tools[id] ?? "tool", output: `error: ${errorOf(d["error"])}` })
        break
      }
      case "session.step.failed":
        events.push({ kind: "error", message: errorOf(d["error"]) })
        break
      case "session.execution.succeeded":
        done = true
        events.push({ kind: "result", status: "succeeded", summary: lastText })
        break
      case "session.execution.failed":
        done = true
        events.push({ kind: "result", status: "failed", error: errorOf(d["error"]) })
        break
      case "session.execution.interrupted": {
        const reason = str(d["reason"])
        // "shutdown": the host stopped (an evicted cell); OpenCode resumes the turn
        // on its next boot, so the run is still going.
        if (reason === "shutdown") break
        done = true
        events.push(
          reason === "user"
            ? { kind: "result", status: "cancelled" }
            : { kind: "result", status: "failed", error: `OpenCode interrupted the run (${reason ?? "unknown"})` }
        )
        break
      }
      default:
        break
    }
  }
  return { events, state: { seq, tools, lastText, done } }
}

/**
 * The seq just before the prompt `promptId` entered the session, if it did. The
 * durable log is the only reliable record: OpenCode accepts a repeated prompt id
 * and runs it again, and its inbox forgets a prompt once delivered.
 */
export const promptStart = (items: ReadonlyArray<unknown>, promptId: string): number | undefined => {
  for (const raw of items) {
    const decoded = decodeItem(raw)
    if (decoded._tag === "None") continue
    const { type, durable, data } = decoded.value
    if (type === "session.inbox.enqueued" && durable && data?.["inboxID"] === promptId) return durable.seq - 1
  }
  return undefined
}
