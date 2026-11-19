import { describe, expect, it } from "vitest"
import { authArgs, defaultGit } from "../src/adapters/sandbox/git.ts"
import { branchFor, ensurePullRequest, githubRepo } from "../src/adapters/sandbox/publish.ts"
import { pullRequestTitle } from "../src/adapters/opencode/runtime.ts"

describe("publishing", () => {
  it("names the workspace's branch", () => {
    expect(branchFor("wrk_bb_task-1")).toBe("bb/bb_task-1")
  })

  it("recognises github.com repositories", () => {
    expect(githubRepo("https://github.com/octocat/Hello-World")).toEqual({ owner: "octocat", name: "Hello-World" })
    expect(githubRepo("https://github.com/octocat/Hello-World.git")).toEqual({ owner: "octocat", name: "Hello-World" })
    expect(githubRepo("https://gitlab.com/a/b")).toBeUndefined()
    expect(githubRepo("/tmp/origin")).toBeUndefined()
  })

  it("sends the token to github.com only, for one command, never in the URL", () => {
    const git = { ...defaultGit, githubToken: "ghp_secret" }
    const args = authArgs("https://github.com/o/r", git)
    expect(args[0]).toBe("-c")
    expect(args[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=Authorization: Basic /)
    expect(args.join(" ")).not.toContain("ghp_secret")
    expect(authArgs("https://gitlab.com/o/r", git)).toEqual([])
    expect(authArgs("https://github.com/o/r", defaultGit)).toEqual([])
  })

  it("opens a pull request once, then finds the open one", async () => {
    const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = []
    let open: Array<{ html_url: string }> = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init)
      calls.push({ method: r.method, url: r.url, auth: r.headers.get("authorization"), body: r.method === "POST" ? await r.json() : undefined })
      if (r.method === "GET") return Response.json(open)
      open = [{ html_url: "https://github.com/o/r/pull/7" }]
      return Response.json({ html_url: "https://github.com/o/r/pull/7" }, { status: 201 })
    }
    const pr = { owner: "o", name: "r", head: "bb/x", base: "main", title: "T", body: "B", draft: true }
    expect(await ensurePullRequest(fetch, "tok", pr)).toEqual({ url: "https://github.com/o/r/pull/7", created: true })
    expect(await ensurePullRequest(fetch, "tok", pr)).toEqual({ url: "https://github.com/o/r/pull/7", created: false })
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls?state=open&head=o%3Abb%2Fx")
    expect(calls[0]?.auth).toBe("Bearer tok")
    expect(calls[1]?.body).toEqual({ title: "T", head: "bb/x", base: "main", body: "B", draft: true })
  })

  it("titles the pull request after the issue and the task's first line", () => {
    expect(pullRequestTitle({ taskId: "t", prompt: "\nFix the login form\nmore", issue: { identifier: "BB-12" } })).toBe("BB-12: Fix the login form")
    expect(pullRequestTitle({ taskId: "t", prompt: "x".repeat(100) })).toHaveLength(72)
  })
})
