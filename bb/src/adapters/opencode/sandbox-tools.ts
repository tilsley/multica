import type { OpenCode } from "@opencode/sdk/effect"
import { Tool } from "@opencode/sdk/effect"
import { Clock, Effect } from "effect"
import type { Sandboxes } from "../../ports/index.ts"

// OpenCode tools that would touch the HOST, run in the sandbox instead. In a
// location backed by a bb workspace this plugin keeps each tool's name, schema
// and description, and replaces only how it runs:
//
//   shell  OpenCode's own streams each command's output into a file on the
//          host's disk and waits for it to open; a Durable Object has no disk
//          (it waits forever in celld). Here: Sandboxes.exec.
//   glob, grep  OpenCode's look for the `rg` binary on the host (downloading it
//          when missing, which egress refuses), then run it in the sandbox:
//          "ripgrep execution failed". Here: the sandbox's own rg, with
//          OpenCode's arguments, and results in OpenCode's declared shapes.
//
// Other locations keep OpenCode's own tools.

type Plugin = NonNullable<OpenCode.CreateOptions["plugins"]>[number]

/** Output kept for the model (the tail: the end of a long build log is what matters). */
const maxOutput = 30_000
const defaultTimeoutMs = 120_000
/** OpenCode's default for glob and grep. */
const defaultSearchLimit = 100
const maxLineChars = 2000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const str = (input: unknown, key: string): string | undefined => {
  const v = isObject(input) ? input[key] : undefined
  return typeof v === "string" && v !== "undefined" && v !== "null" ? v : undefined
}
const bool = (input: unknown, key: string): boolean | undefined => {
  const v = isObject(input) ? input[key] : undefined
  return typeof v === "boolean" ? v : undefined
}
const int = (input: unknown, key: string): number | undefined => {
  const v = isObject(input) ? input[key] : undefined
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined
}

/** Joins a path onto a directory and normalizes `.` and `..` (POSIX). */
export const resolvePath = (base: string, path: string): string => {
  const parts: Array<string> = []
  for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

/** `to` relative to `from` (both absolute, normalized). */
export const relativePath = (from: string, to: string): string => {
  const a = from.split("/").filter((p) => p !== "")
  const b = to.split("/").filter((p) => p !== "")
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const rel = [...Array.from({ length: a.length - i }, () => ".."), ...b.slice(i)].join("/")
  return rel === "" ? "." : rel
}

const normalizeRgPath = (p: string) => p.replace(/^(?:\.\/)+/, "")

// --- shell ------------------------------------------------------------------

/** Combined stdout and stderr, as OpenCode's shell reports it (keeping the tail when long). */
const combined = (stdout: Uint8Array, stderr: Uint8Array): string => {
  const decoder = new TextDecoder()
  const text = decoder.decode(stdout) + decoder.decode(stderr)
  return text.length > maxOutput ? `[output truncated: last ${maxOutput} characters of ${text.length}]\n${text.slice(-maxOutput)}` : text
}

/** What the model reads: the output, and the exit code when it is not 0. */
const message = (output: string, exitCode: number) => {
  const text = output.trim() === "" ? "(no output)" : output
  return exitCode === 0 ? text : `${text}\n[exit code ${exitCode}]`
}

// --- glob and grep: OpenCode's ripgrep arguments and output ------------------

export const globArgs = (pattern: string, hidden: boolean): Array<string> => [
  "--no-config",
  "--files",
  ...(hidden ? ["--hidden"] : []),
  `--glob=${pattern}`,
  ...(hidden ? [] : ["--glob=!**/.*"]),
  "--glob=!**/.git/**",
  "."
]

export const grepArgs = (input: { readonly pattern: string; readonly literal?: boolean | undefined; readonly caseSensitive?: boolean | undefined; readonly include?: string | undefined; readonly file?: string | undefined }): Array<string> => [
  "--no-config",
  "--json",
  "--hidden",
  "--no-messages",
  ...(input.literal ? ["--fixed-strings"] : []),
  ...(input.caseSensitive === false ? ["--ignore-case"] : []),
  ...(input.include ? [`--glob=${input.include}`] : []),
  "--glob=!**/.git/**",
  "--",
  input.pattern,
  input.file ?? "."
]

export interface Match {
  readonly entry: { readonly path: string; readonly type: "file" }
  readonly line: number
  readonly offset: number
  readonly text: string
  readonly submatches: ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number }>
}

const textOf = (v: unknown): string => (isObject(v) && typeof v.text === "string" ? v.text : "")

/** One `rg --json` line to a match (paths as rg printed them), or nothing for other records. */
export const parseRgJson = (line: string): Match | undefined => {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(json) || json.type !== "match" || !isObject(json.data)) return undefined
  const d = json.data
  const raw = textOf(d.lines).replace(/\r?\n$/, "")
  const submatches = Array.isArray(d.submatches)
    ? d.submatches.flatMap((s: unknown) =>
        isObject(s) && typeof s.start === "number" && typeof s.end === "number" ? [{ text: textOf(s.match), start: s.start, end: s.end }] : []
      )
    : []
  return {
    entry: { path: normalizeRgPath(textOf(d.path)), type: "file" },
    line: typeof d.line_number === "number" ? d.line_number : 0,
    offset: typeof d.absolute_offset === "number" ? d.absolute_offset : 0,
    text: raw.length > maxLineChars ? `${raw.slice(0, maxLineChars)}...` : raw,
    submatches
  }
}

const truncatedNote = (n: number) => `\n(Results are truncated: showing first ${n} results. Consider using a more specific path or pattern.)`

const globContent = (paths: ReadonlyArray<string>, truncated: boolean) =>
  (paths.length === 0 ? "No files found" : paths.join("\n")) + (truncated ? `\n${truncatedNote(paths.length)}` : "")

const grepContent = (matches: ReadonlyArray<Match>, truncated: boolean) => {
  const lines = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  let current = ""
  for (const m of matches) {
    if (current !== m.entry.path) {
      if (current) lines.push("")
      current = m.entry.path
      lines.push(`${m.entry.path}:`)
    }
    lines.push(`  Line ${m.line}: ${m.text}`)
  }
  return lines.join("\n") + (truncated ? `\n${truncatedNote(matches.length)}` : "")
}

// --- the plugin ---------------------------------------------------------------

const toolError = (what: string) => (e: { readonly reason: string }) => new Tool.Error({ message: `${what}: ${e.reason}` })

export const sandboxToolsPlugin = (sandboxes: Sandboxes["Service"]): Plugin => ({
  id: "bb-sandbox-tools",
  effect: (context) => {
    const workspace = context.location.workspaceID
    if (workspace === undefined) return Effect.void
    const home = context.location.directory

    const rg = (cwd: string, args: ReadonlyArray<string>) =>
      sandboxes.exec(workspace, { argv: ["rg", ...args], cwd, timeoutMs: defaultTimeoutMs }).pipe(
        Effect.mapError(toolError("sandbox")),
        Effect.flatMap((r) => {
          // 0: results, 1: none, 2: errors (some files unreadable) but results may follow.
          if (r.exitCode > 2 || (r.exitCode === 2 && r.stdout.length === 0)) {
            const err = new TextDecoder().decode(r.stderr).trim()
            return Effect.fail(new Tool.Error({ message: err || `ripgrep failed with code ${r.exitCode}` }))
          }
          return Effect.succeed(new TextDecoder().decode(r.stdout).split("\n").filter((l) => l !== ""))
        })
      )

    return context.tool
      .transform((tools) => {
        tools.update("shell", (tool) => {
          tool.execute = (input: unknown) =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis
              const r = yield* sandboxes
                .exec(workspace, { argv: ["bash", "-c", str(input, "command") ?? ""], cwd: resolvePath(home, str(input, "workdir") ?? "."), timeoutMs: int(input, "timeout") ?? defaultTimeoutMs })
                .pipe(Effect.mapError(toolError("sandbox")))
              const output = combined(r.stdout, r.stderr)
              const wallTimeSeconds = ((yield* Clock.currentTimeMillis) - started) / 1000
              // The shape of OpenCode's own shell result (its declared output schema).
              return { output: { exitCode: r.exitCode, output, wallTimeSeconds }, content: [{ type: "text" as const, text: message(output, r.exitCode) }] }
            })
        })
        tools.update("glob", (tool) => {
          tool.execute = (input: unknown) =>
            Effect.gen(function* () {
              const pattern = str(input, "pattern") ?? "*"
              const root = resolvePath(home, str(input, "path") ?? ".")
              const limit = int(input, "limit") ?? defaultSearchLimit
              const found = yield* rg(root, globArgs(pattern, bool(input, "hidden") ?? false))
              const shown = found.slice(0, limit).map((p) => resolvePath(root, normalizeRgPath(p)))
              const truncated = found.length > limit
              return {
                output: shown.map((p) => ({ path: relativePath(home, p), type: "file" as const })),
                content: globContent(shown, truncated),
                metadata: { count: shown.length, truncated }
              }
            })
        })
        tools.update("grep", (tool) => {
          tool.execute = (input: unknown) =>
            Effect.gen(function* () {
              const target = resolvePath(home, str(input, "path") ?? ".")
              const limit = int(input, "limit") ?? defaultSearchLimit
              // A directory is searched from inside it; a file from its directory.
              const kind = yield* sandboxes.exec(workspace, { argv: ["test", "-d", target], cwd: home }).pipe(Effect.mapError(toolError("sandbox")))
              const isDir = kind.exitCode === 0
              const cwd = isDir ? target : resolvePath(target, "..")
              const file = isDir ? undefined : target.slice(cwd.length + 1)
              const lines = yield* rg(cwd, grepArgs({ pattern: str(input, "pattern") ?? "", literal: bool(input, "literal"), caseSensitive: bool(input, "caseSensitive"), include: str(input, "include"), file }))
              const matches = lines.flatMap((l) => {
                const m = parseRgJson(l)
                return m ? [{ ...m, entry: { ...m.entry, path: relativePath(home, resolvePath(cwd, m.entry.path)) } }] : []
              })
              const shown = matches.slice(0, limit)
              const truncated = matches.length > limit
              return { output: shown, content: grepContent(shown, truncated), metadata: { count: shown.length, truncated } }
            })
        })
      })
      .pipe(Effect.asVoid)
  }
})
