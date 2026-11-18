import { Effect, Result } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { defaultClaudeModel, egress, modelSetup } from "../src/adapters/model/index.ts"
import { makeOpenCodeRuntime } from "../src/adapters/opencode/runtime.ts"
import { scriptedMessages } from "../src/adapters/scripted-model/anthropic.ts"
import { defaultSessionId } from "../src/app/cell.ts"
import { makeOpenCodeHost } from "./opencode-host.ts"
import { drive, request } from "./runtime-contract.ts"

const offline = () => Promise.reject(new Error("no network in tests"))
const failure = (r: ReturnType<typeof modelSetup>) => (Result.isFailure(r) ? r.failure.reason : undefined)

describe("model setting (BB_MODEL)", () => {
  it("defaults to the scripted model", () => {
    const setup = Result.getOrThrow(modelSetup({}, offline))
    expect(setup.ref).toEqual({ providerID: "scripted", id: "bb-scripted" })
  })

  it("refuses an unknown mode, and claude without a key or with a bad base URL", () => {
    expect(failure(modelSetup({ BB_MODEL: "gpt" }, offline))).toContain('unknown BB_MODEL "gpt"')
    expect(failure(modelSetup({ BB_MODEL: "claude" }, offline))).toContain("needs ANTHROPIC_API_KEY")
    expect(failure(modelSetup({ BB_MODEL: "claude", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "nope" }, offline))).toContain("not a URL")
  })

  it("claude defaults to the current Opus and can be overridden", () => {
    expect(Result.getOrThrow(modelSetup({ BB_MODEL: "claude", ANTHROPIC_API_KEY: "k" }, offline)).ref.id).toBe(defaultClaudeModel)
    expect(Result.getOrThrow(modelSetup({ BB_MODEL: "claude", ANTHROPIC_API_KEY: "k", BB_CLAUDE_MODEL: "claude-sonnet-5-5" }, offline)).model).toBe("claude/claude-sonnet-5-5")
  })

  it("describes itself without the key", () => {
    const setup = Result.getOrThrow(modelSetup({ BB_MODEL: "claude", ANTHROPIC_API_KEY: "sk-secret" }, offline))
    expect(setup.describe).not.toContain("sk-secret")
  })

  it("egress reaches only the listed hosts", async () => {
    const out = egress({ "api.anthropic.com": async () => new Response("ok") })
    expect(await (await out("https://api.anthropic.com/v1/messages")).text()).toBe("ok")
    expect((await out("https://evil.example/x")).status).toBe(403)
    expect((await out("http://127.0.0.1:4096/")).status).toBe(403)
  })
})

describe("OpenCode on BB_MODEL=claude (a fake Anthropic endpoint, no billed calls)", () => {
  const seen: Array<{ url: string; key: string | null; auth: string | null; model: unknown }> = []
  const anthropic = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const body: unknown = await req.clone().json()
    seen.push({
      url: req.url,
      key: req.headers.get("x-api-key"),
      auth: req.headers.get("authorization"),
      model: typeof body === "object" && body !== null && "model" in body ? body.model : undefined
    })
    return scriptedMessages(req)
  }
  const setup = Result.getOrThrow(modelSetup({ BB_MODEL: "claude", ANTHROPIC_API_KEY: "sk-test-key" }, anthropic))
  const hostP = makeOpenCodeHost(setup)
  afterAll(async () => (await hostP).close())

  it("sends the run to api.anthropic.com with the key and the configured model", async () => {
    const host = await hostP
    const runtime = makeOpenCodeRuntime({ host: async () => host.host, model: host.ref, directory: host.dir, heartbeatEveryMs: 50 })
    const cursor = await Effect.runPromise(runtime.start({ runId: "m-claude", sessionId: defaultSessionId("m-claude"), request: request("m-claude") }))
    const { events } = await drive(runtime, "m-claude", cursor)
    expect(events.at(-1)).toMatchObject({ kind: "result", status: "succeeded" })
    const call = seen.find((s) => s.url.endsWith("/v1/messages"))
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages")
    expect([call?.key, call?.auth?.replace(/^Bearer /, "")]).toContain("sk-test-key")
    expect(call?.model).toBe(defaultClaudeModel)
    expect(JSON.stringify(events)).not.toContain("sk-test-key")
  })
})
