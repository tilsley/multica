import { spawn } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { WorkspaceSpec } from "../../ports/index.ts"
import { repoDir } from "./tree.ts"

export interface Run {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/** Runs a process to completion (no shell). */
export const run = (
  argv: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined; readonly stdin?: Uint8Array | undefined; readonly timeoutMs?: number | undefined }
): Promise<Run> =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    if (cmd === undefined) return reject(new Error("empty command"))
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...options.env },
      timeout: options.timeoutMs,
      stdio: ["pipe", "pipe", "pipe"]
    })
    const out: Array<Buffer> = []
    const err: Array<Buffer> = []
    child.stdout.on("data", (b: Buffer) => out.push(b))
    child.stderr.on("data", (b: Buffer) => err.push(b))
    child.on("error", reject)
    child.on("close", (code, signal) =>
      resolve({ exitCode: code ?? (signal ? 128 + 9 : 1), stdout: new Uint8Array(Buffer.concat(out)), stderr: new Uint8Array(Buffer.concat(err)) })
    )
    child.stdin.end(options.stdin ?? new Uint8Array())
  })

const exists = (path: string) => stat(path).then(() => true, () => false)

/**
 * bb's copy of a workspace: each repository cloned into `<dir>/<name>`. Idempotent:
 * a repository already cloned is left as it is (it holds earlier runs' changes).
 */
export const cloneInto = async (dir: string, spec: WorkspaceSpec): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await Promise.all(
    spec.repos.map(async (repo) => {
      const target = join(dir, repoDir(repo.url))
      if (await exists(target)) return
      const ref = repo.ref ? ["--branch", repo.ref] : []
      const r = await run(["git", "clone", "--depth", "50", ...ref, "--", repo.url, target], { cwd: dir, timeoutMs: 300_000 })
      if (r.exitCode !== 0) throw new Error(`git clone ${repo.url} failed: ${new TextDecoder().decode(r.stderr).trim()}`)
    })
  )
}
