import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeOpenCodeRuntime } from "../src/adapters/opencode/runtime.ts"
import { makeLocalSandboxes } from "../src/adapters/sandbox/local.ts"
import { defaultSessionId } from "../src/app/cell.ts"
import { makeOpenCodeHost, scriptedSetup } from "./opencode-host.ts"
import { drive, request } from "./runtime-contract.ts"
import { makeOrigin } from "./sandboxes-contract.ts"

// OpenCode with every tool in a sandbox: the repository is cloned into bb's copy,
// the agent's shell runs in the sandbox, and the run's changes come back.

describe("OpenCode in a sandbox", () => {
  const sandboxes = makeLocalSandboxes(mkdtempSync(join(tmpdir(), "bb-sbx-")))
  const hostP = makeOpenCodeHost(scriptedSetup(), sandboxes)
  afterAll(async () => (await hostP).close())
  const run = Effect.runPromise

  it("runs the agent's commands in the sandbox and copies the changes back to bb's copy", async () => {
    const host = await hostP
    const origin = makeOrigin()
    const repo = origin.split("/").at(-1) ?? ""
    const runtime = makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50, sandboxes })
    const sessionId = defaultSessionId("s-edit")
    const task = { ...request("s-edit", `Add a greeting\nrun: echo hello > ${repo}/hello.txt && cat ${repo}/app.txt`), repos: [{ url: origin }] }
    const { events } = await drive(runtime, "s-edit", await run(runtime.start({ runId: "s-edit", sessionId, request: task })))

    expect(events.at(-1)).toMatchObject({ kind: "result", status: "succeeded" })
    // The shell ran where the repository is: app.txt came from the clone.
    expect(events.some((e) => e.kind === "result" && e.summary?.includes("v1"))).toBe(true)
    expect(events).toContainEqual({ kind: "text", text: `Changed in the workspace: ${repo}/hello.txt` })
    // bb's copy has the change: after giving the sandbox back, a new one starts from it.
    const key = `wrk_${sessionId.replace(/^ses_/, "")}`
    await run(sandboxes.release(key))
    const { root } = await run(sandboxes.open({ key, repos: [{ url: origin }] }))
    expect(new TextDecoder().decode(await run(sandboxes.readFile(key, `${root}/${repo}/hello.txt`)))).toBe("hello\n")
  })

  it("runs the shell tool through the sandbox itself (bb's plugin): a failing command reports its exit code", async () => {
    const host = await hostP
    const runtime = makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50, sandboxes })
    const task = { ...request("s-fail", "Check something\nrun: echo oops >&2; exit 3"), repos: [] }
    const { events } = await drive(runtime, "s-fail", await run(runtime.start({ runId: "s-fail", sessionId: defaultSessionId("s-fail"), request: task })))
    const result = events.at(-1)
    expect(result?.kind === "result" && result.summary).toContain("oops\n\n[exit code 3]")
  })
})
