import { describe, expect, it } from "vitest"
import { makeStack } from "./harness.ts"

// The bb contract (docs/bb-contract.md) end to end through the real HTTP handler,
// front and cell use cases, over fake cells and the scripted runtime.

const kinds = (events: ReadonlyArray<Record<string, unknown>>) => events.map((e) => e["kind"])
const ids = (events: ReadonlyArray<Record<string, unknown>>) => events.map((e) => e["id"])

describe("bb contract over HTTP", () => {
  it("health answers protocol v1 without auth", async () => {
    const s = await makeStack()
    const res = await s.handler(new Request("http://bb.test/health"))
    expect(await res.json()).toEqual({ protocolVersion: 1, version: "test" })
  })

  it("rejects a missing or wrong bearer token", async () => {
    const s = await makeStack()
    const res = await s.call("PUT", "/tasks/t", { protocolVersion: 1, taskId: "t", prompt: "x" }, { authorization: "Bearer nope" })
    expect(res.status).toBe(401)
  })

  it("runs a task to completion and streams ordered events ending in the result", async () => {
    const s = await makeStack({ steps: 4 })
    const put = await s.put("t1", { resumeSessionId: "sess-9" })
    expect(put).toEqual({
      status: 200,
      body: { taskId: "t1", created: true, status: "running", sessionId: "sess-9", lastEventId: 0, protocolVersion: 1 }
    })
    const { events } = await s.events("t1")
    expect(ids(events)).toEqual(events.map((_, i) => i + 1))
    expect(events.at(-1)).toMatchObject({ kind: "result", status: "succeeded", sessionId: "sess-9" })
    expect(events[0]).toMatchObject({ kind: "thought", text: expect.stringContaining("Resuming session sess-9") })
    expect(kinds(events)).toContain("tool_call")
  })

  it("an idempotent PUT never starts a second run", async () => {
    const s = await makeStack()
    const first = await s.put("dup")
    const again = await Promise.all([s.put("dup"), s.put("dup"), s.put("dup")])
    expect(first.body["created"]).toBe(true)
    for (const r of again) expect(r.body).toMatchObject({ taskId: "dup", created: false })
    await s.events("dup")
    expect(s.runtime.started).toEqual(["dup"])
  })

  it("a retry chain (retryOf) reattaches to the first run: one run across attempts", async () => {
    const s = await makeStack({ steps: 3 })
    await s.put("a1")
    const a2 = await s.put("a2", { retryOf: "a1", attempt: 2 })
    expect(a2.body).toMatchObject({ taskId: "a1", created: false })
    const a3 = await s.put("a3", { retryOf: "a2", attempt: 3 })
    expect(a3.body).toMatchObject({ taskId: "a1", created: false })
    const viaGrandchild = await s.events("a3")
    expect(viaGrandchild.events.at(-1)).toMatchObject({ kind: "result", status: "succeeded" })
    expect(s.runtime.started).toEqual(["a1"])
  })

  it("a manual rerun (no retryOf) is a fresh run", async () => {
    const s = await makeStack({ steps: 1 })
    await s.put("r1")
    await s.put("r2")
    await Promise.all([s.events("r1"), s.events("r2")])
    expect(s.runtime.started.toSorted()).toEqual(["r1", "r2"])
  })

  it("since=N resumes with no duplicates and no gaps", async () => {
    const s = await makeStack({ steps: 6 })
    await s.put("res")
    const head = await s.events("res", 0, 3)
    const tail = await s.events("res", 3)
    const all = await s.events("res", 0)
    expect([...ids(head.events), ...ids(tail.events)]).toEqual(ids(all.events))
  })

  it("Last-Event-ID resumes like since", async () => {
    const s = await makeStack({ steps: 2 })
    await s.put("lei")
    const all = await s.events("lei")
    const res = await s.call("GET", "/tasks/lei/events", undefined, { "last-event-id": "2" })
    const text = await res.text()
    expect(text.startsWith(`id: 3\n`)).toBe(true)
    expect(all.events.length).toBeGreaterThan(2)
  })

  it("heartbeats keep flowing while the agent works", async () => {
    const s = await makeStack({ steps: 2, stepDelayMs: 120, heartbeatEveryMs: 20 })
    await s.put("hb")
    const { events } = await s.events("hb")
    expect(kinds(events).filter((k) => k === "heartbeat").length).toBeGreaterThan(2)
    expect(events.at(-1)?.["kind"]).toBe("result")
  })

  it("a silent agent emits nothing (no heartbeats) while silent", async () => {
    const s = await makeStack({ steps: 1, silentForMs: 200, heartbeatEveryMs: 10 })
    await s.put("quiet")
    await new Promise((r) => setTimeout(r, 120))
    const snap = s.cells.get("quiet").store.snapshot()
    expect(snap.log.map((e) => e.kind)).toEqual(["thought"])
  })

  it("cancel stops the run, tells the runtime, and ends the stream", async () => {
    const s = await makeStack({ steps: 50, stepDelayMs: 50 })
    await s.put("c1")
    await s.events("c1", 0, 1)
    const res = await s.call("POST", "/tasks/c1/cancel")
    expect(await res.json()).toMatchObject({ _tag: "Cancelled", taskId: "c1", status: "cancelled" })
    const { events } = await s.events("c1")
    expect(events.at(-1)).toMatchObject({ kind: "result", status: "cancelled" })
    expect(s.runtime.cancelled).toEqual(["c1"])
  })

  it("cancelling an alias cancels its run", async () => {
    const s = await makeStack({ steps: 50, stepDelayMs: 50 })
    await s.put("p1")
    await s.put("p2", { retryOf: "p1" })
    await s.call("POST", "/tasks/p2/cancel")
    expect((await s.events("p1")).events.at(-1)).toMatchObject({ kind: "result", status: "cancelled" })
  })

  it("cancel before create tombstones the id: a late PUT gets 409", async () => {
    const s = await makeStack()
    const res = await s.call("POST", "/tasks/early/cancel")
    expect(await res.json()).toEqual({ taskId: "early", status: "cancelled", tombstoned: true })
    expect((await s.put("early")).status).toBe(409)
  })

  it("rejects a malformed task (400) and a body/path mismatch (400)", async () => {
    const s = await makeStack()
    expect((await s.call("PUT", "/tasks/x", { protocolVersion: 1, taskId: "x" })).status).toBe(400)
    expect((await s.call("PUT", "/tasks/x", { protocolVersion: 1, taskId: "y", prompt: "p" })).status).toBe(400)
    expect((await s.call("PUT", "/tasks/x", { protocolVersion: 2, taskId: "x", prompt: "p" })).status).toBe(400)
  })

  it("events for an unknown task are 404", async () => {
    const s = await makeStack()
    expect((await s.call("GET", "/tasks/nope/events")).status).toBe(404)
  })

  it("answers 503 while cells are unreachable, then recovers", async () => {
    const s = await makeStack({ steps: 1 })
    s.cells.faults.unavailable = true
    expect((await s.put("down")).status).toBe(503)
    s.cells.faults.unavailable = false
    expect((await s.put("down")).status).toBe(200)
    expect((await s.events("down")).events.at(-1)?.["kind"]).toBe("result")
  })

  it("survives eviction mid-run: resumes from the persisted cursor with no duplicate events", async () => {
    const s = await makeStack({ steps: 6, stepDelayMs: 30 })
    await s.put("ev")
    await s.events("ev", 0, 3)
    s.cells.get("ev").evict()
    const { events } = await s.events("ev")
    expect(ids(events)).toEqual(events.map((_, i) => i + 1))
    expect(events.filter((e) => e["kind"] === "result")).toHaveLength(1)
    expect(s.runtime.started).toEqual(["ev"])
  })

  it("keeps the runtime retrying while it is unavailable, then finishes", async () => {
    const s = await makeStack({ steps: 1 })
    s.runtime.unavailable = true
    await s.put("rt")
    await new Promise((r) => setTimeout(r, 60))
    s.runtime.unavailable = false
    expect((await s.events("rt")).events.at(-1)).toMatchObject({ kind: "result", status: "succeeded" })
  })

  it("indexes every task in the mailbox with its issue, session and status", async () => {
    const s = await makeStack({ steps: 1 })
    await s.put("m1", { issue: { identifier: "BB-1" } })
    await s.put("m2", { retryOf: "m1" })
    await s.events("m1")
    const byId = Object.fromEntries(s.summaries().map((r) => [r.taskId, r]))
    expect(byId["m1"]).toMatchObject({ runId: "m1", state: "Run", status: "succeeded", issue: "BB-1" })
    expect(byId["m2"]).toMatchObject({ runId: "m1", state: "Alias" })
  })
})
