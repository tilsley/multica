import { execFileSync } from "node:child_process"
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

  it("publishes a run's changes when asked: the workspace's branch is pushed", async () => {
    const host = await hostP
    const origin = makeOrigin()
    const repo = origin.split("/").at(-1) ?? ""
    const runtime = makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50, sandboxes, publish: { draft: true } })
    const task = { ...request("s-pub", `Add a file\nrun: echo hi > ${repo}/published.txt`), repos: [{ url: origin }] }
    const { events } = await drive(runtime, "s-pub", await run(runtime.start({ runId: "s-pub", sessionId: defaultSessionId("s-pub"), request: task })))
    expect(events.at(-1)).toMatchObject({ kind: "result", status: "succeeded" })
    const pushed = events.find((e) => e.kind === "text" && e.text.startsWith("Pushed branch "))
    expect(pushed).toEqual({ kind: "text", text: `Pushed branch bb/bb_s-pub to ${origin}` })
    expect(execFileSync("git", ["show", "bb/bb_s-pub:published.txt"], { cwd: origin }).toString()).toBe("hi\n")
  })

  it("tells the agent where its repositories are", async () => {
    const host = await hostP
    const origin = makeOrigin()
    const repo = origin.split("/").at(-1) ?? ""
    const runtime = makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50, sandboxes })
    const task = { ...request("s-note", "Look around"), repos: [{ url: origin }] }
    const before = host.modelRequests().length
    await drive(runtime, "s-note", await run(runtime.start({ runId: "s-note", sessionId: defaultSessionId("s-note"), request: task })))
    const sent = host.modelRequests().slice(before).join("\n")
    expect(sent).toContain("The repositories are checked out there:")
    expect(sent).toContain(`/${repo} (${origin})`)
  })

  it("glob and grep search the sandbox (with the sandbox's own ripgrep)", async () => {
    const host = await hostP
    const origin = makeOrigin()
    const repo = origin.split("/").at(-1) ?? ""
    const runtime = makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50, sandboxes })
    const session = defaultSessionId("s-search")
    const go = async (runId: string, prompt: string) => {
      const task = { ...request(runId, prompt), repos: [{ url: origin }] }
      const { events } = await drive(runtime, runId, await run(runtime.start({ runId, sessionId: session, request: task })))
      const result = events.at(-1)
      return result?.kind === "result" ? (result.summary ?? "") : ""
    }
    const files = await go("s-glob", "Find text files\nglob: **/*.txt")
    expect(files).toContain(`/${repo}/app.txt`)
    expect(files).not.toContain("No files found")
    const hits = await go("s-grep", "Find the version\ngrep: v1")
    expect(hits).toContain("Found 1 matches")
    expect(hits).toContain(`${repo}/app.txt:`)
    expect(hits).toContain("Line 1: v1")
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
