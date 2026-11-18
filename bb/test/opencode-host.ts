import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { OpenCode } from "@opencode/sdk"
import { type ModelSetup, modelSetup } from "../src/adapters/model/index.ts"

export const scriptedSetup = (): ModelSetup =>
  Result.getOrThrow(modelSetup({}, () => Promise.reject(new Error("the scripted model needs no network"))))

/**
 * A real OpenCode host (the Bun profile of @opencode/sdk) with its own temp
 * database, on the given model setup (the scripted model by default). Counts model
 * calls so tests can assert "one run".
 */
export const makeOpenCodeHost = async (setup: ModelSetup = scriptedSetup()) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-opencode-"))
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ providers: setup.providers, model: setup.model }))
  let modelCalls = 0
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && request.url.endsWith("/v1/messages")) modelCalls++
    return setup.fetch(request)
  }
  const host = await OpenCode.create({
    database: { path: join(dir, "opencode.sqlite") },
    fetch,
    config: { directory: dir },
    models: { fetch: false },
    events: { persist: true }
  })
  return { host, dir, ref: setup.ref, modelCalls: () => modelCalls, close: () => host.close() }
}
