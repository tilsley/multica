import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Effect } from "effect"
import { type Sandboxes, SandboxError } from "../../ports/index.ts"
import { cloneInto, run } from "./git.ts"
import { repoDir, syncTree } from "./tree.ts"

// Sandboxes on the local machine: bb's copy in <base>/copies/<key>, the "sandbox"
// a separate directory, <base>/sandboxes/<key>. No isolation: this is the fake the
// tests use and the gateway's fallback where agent-sandbox is not installed. The
// same contract (test/sandboxes-contract.ts) holds for the agent-sandbox adapter.

const safeKey = (key: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error(`bad workspace key: ${key}`)
  return key
}

const fail = (retryable: boolean) => (e: unknown) =>
  new SandboxError({ reason: e instanceof Error ? e.message : String(e), retryable })

const exists = (path: string) => stat(path).then(() => true, () => false)

const attempt = <A>(f: () => Promise<A>, retryable = false) => Effect.tryPromise({ try: f, catch: fail(retryable) })

export const makeLocalSandboxes = (base: string): Sandboxes["Service"] => {
  const copy = (key: string) => join(base, "copies", safeKey(key))
  const box = (key: string) => join(base, "sandboxes", safeKey(key))
  const inBox = (key: string, path: string) => {
    const root = box(key)
    const full = isAbsolute(path) ? resolve(path) : resolve(root, path)
    if (full !== root && !full.startsWith(`${root}/`)) throw new Error(`path outside the workspace: ${path}`)
    return full
  }
  const opened = async (key: string) => {
    if (!(await exists(box(key)))) throw new Error(`workspace ${key} is not open`)
  }

  return {
    open: (spec) =>
      attempt(async () => {
        await cloneInto(copy(spec.key), spec)
        if (!(await exists(box(spec.key)))) {
          await mkdir(dirname(box(spec.key)), { recursive: true })
          await cp(copy(spec.key), box(spec.key), { recursive: true })
        }
        return { root: box(spec.key), repos: spec.repos.map((r) => ({ url: r.url, path: join(box(spec.key), repoDir(r.url)) })) }
      }, true),
    exec: (key, request) =>
      attempt(async () => {
        await opened(key)
        return run(request.argv, { cwd: request.cwd ? inBox(key, request.cwd) : box(key), env: request.env, stdin: request.stdin, timeoutMs: request.timeoutMs })
      }),
    readFile: (key, path) =>
      attempt(async () => {
        await opened(key)
        const full = inBox(key, path)
        return (await exists(full)) ? new Uint8Array(await readFile(full)) : undefined
      }),
    writeFile: (key, path, bytes) =>
      attempt(async () => {
        await opened(key)
        const full = inBox(key, path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, bytes)
      }),
    sync: (key) =>
      attempt(async () => {
        await opened(key)
        return { changed: await syncTree(box(key), copy(key)) }
      }),
    release: (key) => attempt(() => rm(box(key), { recursive: true, force: true }))
  }
}
