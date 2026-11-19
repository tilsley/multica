import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { releaseWhenIdle } from "../src/adapters/sandbox/idle.ts"
import { makeLocalSandboxes } from "../src/adapters/sandbox/local.ts"
import { makeOrigin } from "./sandboxes-contract.ts"

const run = Effect.runPromise
const text = (b: Uint8Array | undefined) => (b === undefined ? undefined : new TextDecoder().decode(b))

it("gives an idle workspace's sandbox back after copying its work, and reopens it on next use", async () => {
  let now = 0
  const released: Array<string> = []
  const inner = makeLocalSandboxes(mkdtempSync(join(tmpdir(), "bb-idle-")))
  const counted = { ...inner, release: (key: string) => inner.release(key).pipe(Effect.tap(() => Effect.sync(() => released.push(key)))) }
  const idle = releaseWhenIdle(counted, { idleMs: 1000, now: () => now })
  const origin = makeOrigin()
  const { repos } = await run(idle.sandboxes.open({ key: "wrk_idle", repos: [{ url: origin }] }))
  const repo = repos[0]?.path ?? ""
  // Unsynced work, then quiet for longer than the threshold.
  await run(idle.sandboxes.writeFile("wrk_idle", `${repo}/work.txt`, new TextEncoder().encode("kept")))
  now = 500
  expect(await run(idle.reap)).toEqual([])
  now = 2000
  expect(await run(idle.reap)).toEqual(["wrk_idle"])
  expect(released).toEqual(["wrk_idle"])
  // Used again: a sandbox again, with the work (it was synced before release).
  expect(text(await run(idle.sandboxes.readFile("wrk_idle", `${repo}/work.txt`)))).toBe("kept")
  expect(await run(idle.reap)).toEqual([])
})

it("adopts sandboxes that were already claimed, and reaps them later", async () => {
  let now = 0
  const inner = makeLocalSandboxes(mkdtempSync(join(tmpdir(), "bb-idle-")))
  await run(inner.open({ key: "wrk_old", repos: [] }))
  const idle = releaseWhenIdle(inner, { idleMs: 1000, now: () => now, existing: async () => ["wrk_old"] })
  expect(await run(idle.adopt)).toBe(1)
  now = 2000
  expect(await run(idle.reap)).toEqual(["wrk_old"])
})
