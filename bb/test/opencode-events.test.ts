import { describe, expect, it } from "vitest"
import { initialState, mapLog, promptStart } from "../src/adapters/opencode/events.ts"

// Shapes as OpenCode 2.3's experimental.session.log returns them (trimmed).
let seq = 0
const item = (type: string, data: Record<string, unknown> = {}) => ({ type, durable: { aggregateID: "s", seq: ++seq, version: 1 }, data })
const reset = () => {
  seq = 0
}

describe("OpenCode durable log -> bb events", () => {
  it("maps a turn with reasoning, a named tool call and text, ending in success with the last text as summary", () => {
    reset()
    const items = [
      item("session.inbox.enqueued", { inboxID: "msg_bb_r1" }),
      item("session.execution.started"),
      item("session.reasoning.ended", { text: "Looking at the login form." }),
      item("session.tool.input.started", { id: "t1", name: "bash" }),
      item("session.tool.called", { id: "t1", input: { command: "go test ./..." } }),
      item("session.tool.success", { id: "t1", content: [{ type: "text", text: "ok" }] }),
      item("session.text.ended", { text: "Fixed the validator." }),
      item("session.execution.succeeded"),
      { type: "log.synced", aggregateID: "s", seq }
    ]
    const { events, state } = mapLog(items, initialState(0))
    expect(events).toEqual([
      { kind: "thought", text: "Looking at the login form." },
      { kind: "tool_call", phase: "start", callId: "t1", tool: "bash", input: { command: "go test ./..." } },
      { kind: "tool_call", phase: "end", callId: "t1", tool: "bash", output: "ok" },
      { kind: "text", text: "Fixed the validator." },
      { kind: "result", status: "succeeded", summary: "Fixed the validator." }
    ])
    expect(state).toMatchObject({ seq: 8, done: true })
  })

  it("resumes across calls: skips replayed items and keeps tool names from earlier batches", () => {
    reset()
    const first = [item("session.tool.input.started", { id: "t9", name: "edit" }), item("session.tool.called", { id: "t9", input: {} })]
    const a = mapLog(first, initialState(0))
    const second = [...first, item("session.tool.failed", { id: "t9", error: { type: "x", message: "file not found" } })]
    const b = mapLog(second, a.state)
    expect(b.events).toEqual([{ kind: "tool_call", phase: "end", callId: "t9", tool: "edit", output: "error: file not found" }])
  })

  it("maps failures and a user interrupt; a host shutdown is not the end of the run", () => {
    reset()
    expect(mapLog([item("session.execution.failed", { error: { type: "rate_limit", message: "overloaded" } })], initialState(0)).events).toEqual([
      { kind: "result", status: "failed", error: "overloaded" }
    ])
    reset()
    const shutdown = mapLog([item("session.execution.interrupted", { reason: "shutdown" })], initialState(0))
    expect(shutdown.events).toEqual([])
    expect(shutdown.state.done).toBe(false)
    reset()
    expect(mapLog([item("session.execution.interrupted", { reason: "user" })], initialState(0)).events).toEqual([
      { kind: "result", status: "cancelled" }
    ])
  })

  it("emits nothing after a terminal event and ignores undecodable items", () => {
    reset()
    const { events } = mapLog(
      [item("session.execution.succeeded"), item("session.text.ended", { text: "late" }), "garbage", { type: 3 }],
      initialState(0)
    )
    expect(events.map((e) => e.kind)).toEqual(["result"])
  })

  it("finds where a run's prompt entered the session (for idempotent start)", () => {
    reset()
    const items = [item("session.text.ended", { text: "old turn" }), item("session.inbox.enqueued", { inboxID: "msg_bb_r2" })]
    expect(promptStart(items, "msg_bb_r2")).toBe(1)
    expect(promptStart(items, "msg_bb_other")).toBeUndefined()
  })
})
