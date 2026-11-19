import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { PublishRequest, PublishedRepo } from "../../ports/index.ts"
import { authArgs, type Fetch, git, type GitSettings } from "./git.ts"

// Publishing bb's copy of a workspace: for each repository with changes, commit
// them to the workspace's branch, push it, and open a pull request (or leave the
// one already open, which now has the new commit). Runs on the gateway's disk:
// the sandbox never holds credentials.

/** The workspace's branch: one per conversation. */
export const branchFor = (key: string) => `bb/${key.replace(/^wrk_/, "").replace(/[^A-Za-z0-9._/-]+/g, "-")}`

/** owner/name of a github.com repository URL, if it is one. */
export const githubRepo = (url: string): { readonly owner: string; readonly name: string } | undefined => {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : undefined
}

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "bb"
})

/** The open pull request for the branch, or a new one. */
export const ensurePullRequest = async (
  fetch: Fetch,
  token: string,
  pr: { readonly owner: string; readonly name: string; readonly head: string; readonly base: string; readonly title: string; readonly body: string; readonly draft: boolean }
): Promise<{ readonly url: string; readonly created: boolean }> => {
  const api = `https://api.github.com/repos/${pr.owner}/${pr.name}/pulls`
  const found = await fetch(`${api}?state=open&head=${encodeURIComponent(`${pr.owner}:${pr.head}`)}`, { headers: githubHeaders(token) })
  if (!found.ok) throw new Error(`GitHub: listing pull requests answered ${found.status}: ${await found.text()}`)
  const open: unknown = await found.json()
  const existing = Array.isArray(open) ? open.find((p: unknown) => typeof p === "object" && p !== null && "html_url" in p && typeof p.html_url === "string") : undefined
  if (existing && typeof existing === "object" && "html_url" in existing && typeof existing.html_url === "string") return { url: existing.html_url, created: false }
  const created = await fetch(api, {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ title: pr.title, head: pr.head, base: pr.base, body: pr.body, draft: pr.draft })
  })
  if (!created.ok) throw new Error(`GitHub: opening a pull request answered ${created.status}: ${await created.text()}`)
  const json: unknown = await created.json()
  const url = typeof json === "object" && json !== null && "html_url" in json && typeof json.html_url === "string" ? json.html_url : ""
  return { url, created: true }
}

const isRepo = (dir: string) => stat(join(dir, ".git")).then(() => true, () => false)

/** Commits and pushes one repository of bb's copy; undefined when it has no changes. */
const publishRepo = async (dir: string, key: string, request: PublishRequest, settings: GitSettings): Promise<PublishedRepo | undefined> => {
  if ((await git(dir, ["status", "--porcelain"])) === "") return undefined
  const url = await git(dir, ["remote", "get-url", "origin"])
  const branch = branchFor(key)
  // The branch starts from wherever the clone was; remember that as the PR's base.
  let base = await git(dir, ["config", "--get", "bb.base"]).catch(() => "")
  if (base === "") {
    base = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])
    await git(dir, ["config", "bb.base", base])
  }
  await git(dir, ["checkout", "-B", branch])
  await git(dir, ["add", "-A"])
  await git(dir, ["-c", `user.name=${settings.author.name}`, "-c", `user.email=${settings.author.email}`, "commit", "-q", "-m", request.title, "-m", request.body])
  await git(dir, [...authArgs(url, settings), "push", "-q", "origin", `HEAD:refs/heads/${branch}`])
  const gh = githubRepo(url)
  if (!gh || !settings.githubToken) return { repo: url, branch }
  const pr = await ensurePullRequest(settings.fetch, settings.githubToken, { ...gh, head: branch, base, title: request.title, body: request.body, draft: request.draft })
  return { repo: url, branch, pullRequest: pr.url, created: pr.created }
}

/** Publishes every repository of bb's copy at `dir` that has changes. */
export const publishCopy = async (dir: string, key: string, request: PublishRequest, settings: GitSettings): Promise<ReadonlyArray<PublishedRepo>> => {
  const names = await readdir(dir).catch(() => [])
  const repos = (await Promise.all(names.map(async (n) => ((await isRepo(join(dir, n))) ? join(dir, n) : undefined)))).filter((d): d is string => d !== undefined)
  const published = await Promise.all(repos.map((d) => publishRepo(d, key, request, settings)))
  return published.filter((p): p is PublishedRepo => p !== undefined)
}
