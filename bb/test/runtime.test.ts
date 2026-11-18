import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { defaultScript, makeScriptedRuntime } from "../src/adapters/fake/runtime.ts"
import { serveRuntime, sessionCellRuntime } from "../src/adapters/durable-object/session-runtime.ts"
import { makeOpenCodeRuntime } from "../src/adapters/opencode/runtime.ts"
import { defaultSessionId } from "../src/app/cell.ts"
import { makeOpenCodeHost } from "./opencode-host.ts"
import { drive, request, runtimeContract } from "./runtime-contract.ts"

// The scripted fake and real OpenCode (Bun host, scripted model) pass the same
// contract; OpenCode's own behaviours (sessions, cancel) are tested below it.

runtimeContract(
  "scripted fake",
  async () => makeScriptedRuntime({ ...defaultScript, stepDelayMs: 5, steps: 3, heartbeatEveryMs: 10 }).service,
  defaultSessionId
)

const host = await makeOpenCodeHost()
afterAll(() => host.close())
const opencode = () =>
  makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50 })

runtimeContract("OpenCode", async () => opencode(), defaultSessionId)

// What a task cell actually uses in celld: OpenCode in the session's own cell,
// reached over RPC (here an in-memory namespace in place of env.SESSIONS).
runtimeContract(
  "OpenCode via session cells",
  async () => {
    const served = serveRuntime(opencode())
    return sessionCellRuntime({ getByName: () => served })
  },
  defaultSessionId
)

describe("OpenCode runtime", () => {
  const run = Effect.runPromise

  it("answers with the model's reply as the summary (the Multica brief is not echoed as the task)", async () => {
    const runtime = opencode()
    const cursor = await run(runtime.start({ runId: "o-sum", sessionId: defaultSessionId("o-sum"), request: request("o-sum", "Add a CI badge") }))
    const { events } = await drive(runtime, "o-sum", cursor)
    const result = events.at(-1)
    expect(result).toMatchObject({ kind: "result", status: "succeeded" })
    expect(result?.kind === "result" && result.summary).toContain('received the task: "Add a CI badge"')
    expect(events.some((e) => e.kind === "text")).toBe(true)
  })

  it("start never sends a run's prompt twice, even when called again after delivery", async () => {
    const runtime = opencode()
    const session = defaultSessionId("o-idem")
    const cursor = await run(runtime.start({ runId: "o-idem", sessionId: session, request: request("o-idem") }))
    await drive(runtime, "o-idem", cursor)
    // OpenCode accepts a repeated prompt id and runs it again, so this is the case
    // the adapter must catch itself.
    const again = await run(runtime.start({ runId: "o-idem", sessionId: session, request: request("o-idem") }))
    await new Promise((r) => setTimeout(r, 1500))
    const executions = async () => {
      let n = 0
      for await (const item of host.host.experimental.session.log({ sessionID: session, after: 0, follow: false })) {
        if (item.type === "session.execution.started") n++
      }
      return n
    }
    expect(await executions()).toBe(1)
    // ...and the restarted cursor still reports this run's own result.
    expect((await drive(runtime, "o-idem", again)).events.filter((e) => e.kind === "result")).toHaveLength(1)
  })

  it("a reply on the same session is a new run that reports only its own events", async () => {
    const runtime = opencode()
    const session = defaultSessionId("o-first")
    const first = await drive(runtime, "o-first", await run(runtime.start({ runId: "o-first", sessionId: session, request: request("o-first", "First task") })))
    expect(first.events.at(-1)).toMatchObject({ status: "succeeded" })
    const second = await drive(
      runtime,
      "o-reply",
      await run(runtime.start({ runId: "o-reply", sessionId: session, request: request("o-reply", "Also update the changelog") }))
    )
    const texts = second.events.filter((e) => e.kind === "text").map((e) => (e.kind === "text" ? e.text : ""))
    expect(texts.join(" ")).toContain("Also update the changelog")
    expect(texts.join(" ")).not.toContain("First task")
    // The model saw the earlier turn: the session's history carried over.
    expect(texts.join(" ")).toContain("(turn 2 of this conversation)")
  })

  it("cancel interrupts the session; the run then ends cancelled or already finished", async () => {
    const runtime = opencode()
    const session = defaultSessionId("o-cancel")
    const cursor = await run(runtime.start({ runId: "o-cancel", sessionId: session, request: request("o-cancel") }))
    await run(runtime.cancel({ runId: "o-cancel", sessionId: session }))
    const { events } = await drive(runtime, "o-cancel", cursor)
    const result = events.at(-1)
    // The scripted model answers instantly, so the turn can finish before the
    // interrupt lands; either way exactly one terminal result.
    expect(result?.kind === "result" && ["cancelled", "succeeded"].includes(result.status)).toBe(true)
  })
})
