import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { AgentEvent, TaskRequest } from "../src/domain/index.ts"
import type { AgentRuntime } from "../src/ports/index.ts"

// Every AgentRuntime adapter passes this: what the cell relies on.

export const request = (taskId: string, prompt = "Fix the login form validation"): TaskRequest => ({
  protocolVersion: 1,
  taskId,
  prompt,
  systemPrompt: "You are bb. Report progress in the Multica issue."
})

/** Polls progress like the cell's ticks do, until a result (or the deadline). */
export const drive = async (runtime: AgentRuntime["Service"], runId: string, cursor: string, deadlineMs = 15_000) => {
  const events: Array<AgentEvent> = []
  const end = Date.now() + deadlineMs
  let at = cursor
  while (Date.now() < end) {
    const { events: batch, cursor: next } = await Effect.runPromise(runtime.progress(runId, at))
    events.push(...batch)
    at = next
    if (batch.some((e) => e.kind === "result")) return { events, cursor: at }
    await new Promise((r) => setTimeout(r, 40))
  }
  return { events, cursor: at }
}

const startWith = (sessionFor: (runId: string) => string) => (runtime: AgentRuntime["Service"], runId: string) =>
  Effect.runPromise(runtime.start({ runId, sessionId: sessionFor(runId), request: request(runId) }))

export const runtimeContract = (name: string, make: () => Promise<AgentRuntime["Service"]>, sessionFor: (runId: string) => string) => {
  const start = startWith(sessionFor)
  describe(`AgentRuntime contract: ${name}`, () => {

    it("runs to exactly one terminal result, last", async () => {
      const runtime = await make()
      const { events } = await drive(runtime, "c-one", await start(runtime, "c-one"))
      const results = events.filter((e) => e.kind === "result")
      expect(results).toHaveLength(1)
      expect(events.at(-1)?.kind).toBe("result")
    })

    it("start is idempotent: a repeated start leads to the same single run", async () => {
      const runtime = await make()
      await start(runtime, "c-twice")
      const { events } = await drive(runtime, "c-twice", await start(runtime, "c-twice"))
      expect(events.filter((e) => e.kind === "result")).toHaveLength(1)
    })

    it("a cursor survives a round trip: resuming from a saved cursor yields no duplicates", async () => {
      const runtime = await make()
      const first = await drive(runtime, "c-cursor", await start(runtime, "c-cursor"))
      const again = await Effect.runPromise(runtime.progress("c-cursor", first.cursor))
      expect(again.events.filter((e) => e.kind !== "heartbeat")).toEqual([])
    })
  })
}
