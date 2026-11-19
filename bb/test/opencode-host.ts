import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk/effect"
import { Effect, Exit, Result, Scope } from "effect"
import { type ModelSetup, modelSetup } from "../src/adapters/model/index.ts"
import { sandboxHostOptions } from "../src/adapters/opencode/workspace.ts"
import type { Sandboxes } from "../src/ports/index.ts"

export const scriptedSetup = (): ModelSetup =>
  Result.getOrThrow(modelSetup({}, () => Promise.reject(new Error("the scripted model needs no network"))))

/**
 * A real OpenCode host (the Bun profile of @opencode/sdk, Effect API) with its own
 * temp database, on the given model setup (the scripted model by default), with
 * bb's sandbox workspace provider when sandboxes are given. Counts (and keeps) model
 * calls so tests can assert "one run" and what the model was told.
 */
export const makeOpenCodeHost = async (setup: ModelSetup = scriptedSetup(), sandboxes?: Sandboxes["Service"]) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-opencode-"))
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ providers: setup.providers, model: setup.model }))
  let modelCalls = 0
  const bodies: Array<string> = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && request.url.endsWith("/v1/messages")) {
      modelCalls++
      bodies.push(await request.clone().text())
    }
    return setup.fetch(request)
  }
  const scope = await Effect.runPromise(Scope.make())
  const host = await Effect.runPromise(
    Scope.provide(
      OpenCode.create({
        database: { path: join(dir, "opencode.sqlite") },
        fetch,
        config: { directory: dir },
        models: { fetch: false },
        events: { persist: true },
        ...(sandboxes ? sandboxHostOptions(sandboxes) : {})
      }),
      scope
    )
  )
  return { host, dir, ref: setup.ref, modelCalls: () => modelCalls, modelRequests: () => bodies, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}
