import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import type { Sandboxes } from "../src/ports/index.ts"

// What every Sandboxes adapter guarantees (local, gateway client, agent-sandbox).

/** A git repository to clone from, with one commit. */
export const makeOrigin = () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-origin-"))
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } })
  git("init", "-q", "-b", "main")
  writeFileSync(join(dir, "README.md"), "# demo\n")
  writeFileSync(join(dir, "app.txt"), "v1\n")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  return dir
}

const text = (b: Uint8Array | undefined) => (b === undefined ? undefined : new TextDecoder().decode(b))
const bytes = (s: string) => new TextEncoder().encode(s)

export const sandboxesContract = (name: string, make: () => Promise<Sandboxes["Service"]>) =>
  describe(`Sandboxes contract: ${name}`, () => {
    const run = Effect.runPromise
    let n = 0
    const fresh = async () => {
      const sandboxes = await make()
      const origin = makeOrigin()
      const key = `wrk_contract_${Date.now()}_${n++}`
      const { root } = await run(sandboxes.open({ key, repos: [{ url: origin }] }))
      const repo = `${root}/${origin.split("/").at(-1)}`
      return { sandboxes, key, root, repo, origin }
    }

    it("open clones the repositories into the workspace, and says where each one is", async () => {
      const { sandboxes, key, repo, origin } = await fresh()
      expect(text(await run(sandboxes.readFile(key, `${repo}/app.txt`)))).toBe("v1\n")
      const again = await run(sandboxes.open({ key, repos: [{ url: origin }] }))
      expect(again.repos).toEqual([{ url: origin, path: repo }])
    })

    it("exec runs in the sandbox: cwd, env, stdin and the exit code", async () => {
      const { sandboxes, key, repo } = await fresh()
      const r = await run(sandboxes.exec(key, { argv: ["sh", "-c", 'cat app.txt; printf "%s" "$GREETING"; cat; exit 3'], cwd: repo, env: { GREETING: "hi" }, stdin: bytes("in") }))
      expect(r.exitCode).toBe(3)
      expect(text(r.stdout)).toBe("v1\nhiin")
    })

    it("files round-trip; a missing file reads as undefined", async () => {
      const { sandboxes, key, repo } = await fresh()
      await run(sandboxes.writeFile(key, `${repo}/new/dir/x.txt`, bytes("x")))
      expect(text(await run(sandboxes.readFile(key, `${repo}/new/dir/x.txt`)))).toBe("x")
      expect(await run(sandboxes.readFile(key, `${repo}/nope.txt`))).toBeUndefined()
    })

    it("open is idempotent: it keeps the sandbox's work", async () => {
      const { sandboxes, key, repo, origin } = await fresh()
      await run(sandboxes.writeFile(key, `${repo}/app.txt`, bytes("v2\n")))
      await run(sandboxes.open({ key, repos: [{ url: origin }] }))
      expect(text(await run(sandboxes.readFile(key, `${repo}/app.txt`)))).toBe("v2\n")
    })

    it("sync copies changes back (added, changed, deleted; never .git) and is then empty", async () => {
      const { sandboxes, key, repo } = await fresh()
      const dir = repo.split("/").at(-1)
      await run(sandboxes.exec(key, { argv: ["sh", "-c", "echo v2 > app.txt && rm README.md && echo n > added.txt && echo junk > .git/junk"], cwd: repo }))
      expect((await run(sandboxes.sync(key))).changed).toEqual([`${dir}/README.md`, `${dir}/added.txt`, `${dir}/app.txt`])
      expect((await run(sandboxes.sync(key))).changed).toEqual([])
    })

    it("after release, open continues from bb's copy: synced work survives, unsynced does not", async () => {
      const { sandboxes, key, repo, origin } = await fresh()
      await run(sandboxes.writeFile(key, `${repo}/kept.txt`, bytes("kept")))
      await run(sandboxes.sync(key))
      await run(sandboxes.writeFile(key, `${repo}/lost.txt`, bytes("lost")))
      await run(sandboxes.release(key))
      await run(sandboxes.release(key))
      const again = await run(sandboxes.open({ key, repos: [{ url: origin }] }))
      const repo2 = `${again.root}/${origin.split("/").at(-1)}`
      expect(text(await run(sandboxes.readFile(key, `${repo2}/kept.txt`)))).toBe("kept")
      expect(await run(sandboxes.readFile(key, `${repo2}/lost.txt`))).toBeUndefined()
    })

    it("publish commits bb's copy to the workspace's branch and pushes it; nothing to publish when nothing changed", async () => {
      const { sandboxes, key, repo, origin } = await fresh()
      const request = { title: "Add notes", body: "Summary", draft: true }
      expect(await run(sandboxes.publish(key, request))).toEqual([])
      await run(sandboxes.writeFile(key, `${repo}/notes.md`, bytes("first")))
      await run(sandboxes.sync(key))
      const [published] = await run(sandboxes.publish(key, request))
      expect(published?.repo).toBe(origin)
      expect(published?.branch).toMatch(/^bb\//)
      const branch = published?.branch ?? ""
      const show = (path: string) => execFileSync("git", ["show", `${branch}:${path}`], { cwd: origin }).toString()
      expect(show("notes.md")).toBe("first")
      expect(execFileSync("git", ["log", "-1", "--format=%s", branch], { cwd: origin }).toString().trim()).toBe("Add notes")
      // Published work is not published again; new work is a new commit on the same branch.
      expect(await run(sandboxes.publish(key, request))).toEqual([])
      await run(sandboxes.writeFile(key, `${repo}/notes.md`, bytes("second")))
      await run(sandboxes.sync(key))
      expect((await run(sandboxes.publish(key, request)))[0]?.branch).toBe(branch)
      expect(show("notes.md")).toBe("second")
    })

    it("using a workspace that is not open fails", async () => {
      const sandboxes = await make()
      const exit = await Effect.runPromiseExit(sandboxes.exec("wrk_never_opened", { argv: ["true"] }))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })
