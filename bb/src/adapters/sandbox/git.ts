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

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** How bb's copies talk to their remotes: credentials and the identity bb commits as. */
export interface GitSettings {
  /** A GitHub token (a PAT or an installation token). Used for github.com only. */
  readonly githubToken?: string | undefined
  readonly author: { readonly name: string; readonly email: string }
  /** For GitHub's API. */
  readonly fetch: Fetch
}

export const defaultGit: GitSettings = { author: { name: "bb", email: "bb@localhost" }, fetch: (input, init) => fetch(input, init) }

/**
 * git options that authenticate to github.com for one command. The token goes in
 * a header for that command only: never into a remote URL or .git/config, which
 * are copied into the sandbox.
 */
export const authArgs = (url: string, git: GitSettings): Array<string> =>
  git.githubToken && url.startsWith("https://github.com/")
    ? ["-c", `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${git.githubToken}`).toString("base64")}`]
    : []

/** Runs git in a directory and returns stdout; fails with git's stderr. */
export const git = async (cwd: string, args: ReadonlyArray<string>, timeoutMs = 300_000): Promise<string> => {
  const r = await run(["git", ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } })
  if (r.exitCode !== 0) throw new Error(`git ${args.filter((a) => !a.startsWith("http.")).join(" ")} failed: ${new TextDecoder().decode(r.stderr).trim()}`)
  return new TextDecoder().decode(r.stdout).trim()
}

/**
 * bb's copy of a workspace: each repository cloned into `<dir>/<name>`. Idempotent:
 * a repository already cloned is left as it is (it holds earlier runs' changes).
 */
export const cloneInto = async (dir: string, spec: WorkspaceSpec, settings: GitSettings = defaultGit): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await Promise.all(
    spec.repos.map(async (repo) => {
      const target = join(dir, repoDir(repo.url))
      if (await exists(target)) return
      const ref = repo.ref ? ["--branch", repo.ref] : []
      await git(dir, [...authArgs(repo.url, settings), "clone", "--depth", "50", ...ref, "--", repo.url, target])
    })
  )
}
