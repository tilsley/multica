import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

// Copying a sandbox's changes back into bb's copy: both sides are directories on
// the gateway's disk (the agent-sandbox adapter first unpacks the sandbox's tree).
// Every `.git` is bb's, and `.bb` is the gateway's own: neither is written back.

const skip = new Set([".git", ".bb"])

const files = async (root: string, at = ""): Promise<Map<string, string>> => {
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = await readdir(join(root, at), { withFileTypes: true })
  } catch {
    return new Map()
  }
  const parts = await Promise.all(
    entries
      .filter((e) => !skip.has(e.name))
      .map(async (e): Promise<Array<[string, string]>> => {
        const rel = at === "" ? e.name : `${at}/${e.name}`
        if (e.isDirectory()) return Array.from(await files(root, rel))
        if (e.isFile()) return [[rel, createHash("sha256").update(await readFile(join(root, rel))).digest("hex")]]
        return []
      })
  )
  return new Map(parts.flat())
}

/** Makes `to` match `from` (outside `.git`); returns the paths that changed, sorted. */
export const syncTree = async (from: string, to: string): Promise<Array<string>> => {
  const [source, target] = await Promise.all([files(from), files(to)])
  const copied = [...source].filter(([path, hash]) => target.get(path) !== hash).map(([path]) => path)
  const removed = [...target.keys()].filter((path) => !source.has(path))
  await Promise.all([
    ...copied.map(async (path) => {
      await mkdir(dirname(join(to, path)), { recursive: true })
      await cp(join(from, path), join(to, path))
    }),
    ...removed.map((path) => rm(join(to, path), { force: true }))
  ])
  return [...copied, ...removed].toSorted()
}

/** The directory a repository is cloned into: its last path segment without `.git`. */
export const repoDir = (url: string): string => {
  const name = url.replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "") ?? ""
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".." ? name : "repo"
}
