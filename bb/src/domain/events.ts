import { Schema } from "effect"

// The contract's event kinds (docs/bb-contract.md). An AgentEvent is what a
// runtime reports; a LogEntry is the same event once a run has given it its
// sequence number (`id`).

const Thought = Schema.Struct({ kind: Schema.Literal("thought"), text: Schema.String })
const Text = Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String })
const ToolCall = Schema.Struct({
  kind: Schema.Literal("tool_call"),
  phase: Schema.Literals(["start", "end"]),
  callId: Schema.String,
  tool: Schema.String,
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  output: Schema.optionalKey(Schema.String)
})
const Heartbeat = Schema.Struct({ kind: Schema.Literal("heartbeat") })
const ErrorEvent = Schema.Struct({ kind: Schema.Literal("error"), message: Schema.String })

export const ResultStatus = Schema.Literals(["succeeded", "failed", "cancelled"])
export type ResultStatus = typeof ResultStatus.Type

const ResultEvent = Schema.Struct({
  kind: Schema.Literal("result"),
  status: ResultStatus,
  summary: Schema.optionalKey(Schema.String),
  prUrl: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

export const AgentEvent = Schema.Union([Thought, Text, ToolCall, Heartbeat, ErrorEvent, ResultEvent])
export type AgentEvent = typeof AgentEvent.Type
export type ResultEvent = typeof ResultEvent.Type

export type LogEntry = AgentEvent & { readonly id: number; readonly at: number }

export const isResult = (event: AgentEvent): event is ResultEvent => event.kind === "result"
