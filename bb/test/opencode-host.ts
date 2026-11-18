import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk"
import { scriptedFetch, scriptedProvider } from "../src/adapters/scripted-model/anthropic.ts"

/**
 * A real OpenCode host (the Bun profile of @opencode/sdk) with the scripted model
 * and its own temp database. Counts model calls so tests can assert "one run".
 */
export const makeOpenCodeHost = async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-opencode-"))
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ providers: scriptedProvider, model: "scripted/bb-scripted" }))
  let modelCalls = 0
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && request.url.endsWith("/v1/messages")) modelCalls++
    return scriptedFetch(request)
  }
  const host = await OpenCode.create({
    database: { path: join(dir, "opencode.sqlite") },
    fetch,
    config: { directory: dir },
    models: { fetch: false },
    events: { persist: true }
  })
  return { host, dir, modelCalls: () => modelCalls, close: () => host.close() }
}
