import { describe, expect, it } from "vitest"
import { globArgs, grepArgs, parseRgJson, relativePath, resolvePath } from "../src/adapters/opencode/sandbox-tools.ts"

describe("sandbox tools: paths", () => {
  it("resolves relative and absolute paths, and normalizes . and ..", () => {
    expect(resolvePath("/workspace", "repo/src")).toBe("/workspace/repo/src")
    expect(resolvePath("/workspace", ".")).toBe("/workspace")
    expect(resolvePath("/workspace/repo", "../other/./x")).toBe("/workspace/other/x")
    expect(resolvePath("/workspace", "/etc/hosts")).toBe("/etc/hosts")
  })
  it("relativePath is the inverse of resolvePath", () => {
    expect(relativePath("/workspace", "/workspace/repo/a.txt")).toBe("repo/a.txt")
    expect(relativePath("/workspace/repo", "/workspace/other")).toBe("../other")
    expect(relativePath("/workspace", "/workspace")).toBe(".")
  })
})

describe("sandbox tools: ripgrep", () => {
  it("uses OpenCode's arguments", () => {
    expect(globArgs("**/*.ts", false)).toEqual(["--no-config", "--files", "--glob=**/*.ts", "--glob=!**/.*", "--glob=!**/.git/**", "."])
    expect(grepArgs({ pattern: "-x", literal: true, caseSensitive: false, include: "*.ts" })).toEqual([
      "--no-config", "--json", "--hidden", "--no-messages", "--fixed-strings", "--ignore-case", "--glob=*.ts", "--glob=!**/.git/**", "--", "-x", "."
    ])
  })
  it("reads matches from rg --json and ignores other records", () => {
    const line = JSON.stringify({
      type: "match",
      data: { path: { text: "./src/a.ts" }, lines: { text: "const v1 = 1\n" }, line_number: 3, absolute_offset: 40, submatches: [{ match: { text: "v1" }, start: 6, end: 8 }] }
    })
    expect(parseRgJson(line)).toEqual({
      entry: { path: "src/a.ts", type: "file" },
      line: 3,
      offset: 40,
      text: "const v1 = 1",
      submatches: [{ text: "v1", start: 6, end: 8 }]
    })
    expect(parseRgJson(JSON.stringify({ type: "begin", data: {} }))).toBeUndefined()
    expect(parseRgJson("not json")).toBeUndefined()
  })
})
