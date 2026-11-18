import type { OpenCode } from "@opencode/sdk/effect"
import { Tool } from "@opencode/sdk/effect"
import { Clock, Effect } from "effect"
import type { Sandboxes } from "../../ports/index.ts"

// OpenCode's `shell` tool, run in the sandbox. OpenCode's own shell tool streams
// each command's output into a file on the host's disk and waits for that file
// to open, and a Durable Object has no disk (it waits forever in celld). In a
// location backed by a bb workspace this plugin keeps the tool (name, schema,
// description) but runs the command through Sandboxes.exec, so nothing touches
// the host's disk. Other locations keep OpenCode's own shell.

type Plugin = NonNullable<OpenCode.CreateOptions["plugins"]>[number]

/** Output kept for the model (the tail: the end of a long build log is what matters). */
const maxOutput = 30_000
const defaultTimeoutMs = 120_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

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

export const sandboxShellPlugin = (sandboxes: Sandboxes["Service"]): Plugin => ({
  id: "bb-sandbox-shell",
  effect: (context) => {
    const workspace = context.location.workspaceID
    if (workspace === undefined) return Effect.void
    return context.tool
      .transform((tools) =>
        tools.update("shell", (tool) => {
          tool.execute = (input: unknown) => {
            const command = isObject(input) && typeof input.command === "string" ? input.command : ""
            const workdir = isObject(input) && typeof input.workdir === "string" ? input.workdir : context.location.directory
            const timeout = isObject(input) && typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : defaultTimeoutMs
            return Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis
              const r = yield* sandboxes
                .exec(workspace, { argv: ["bash", "-c", command], cwd: workdir, timeoutMs: timeout })
                .pipe(Effect.mapError((e) => new Tool.Error({ message: `sandbox: ${e.reason}` })))
              const output = combined(r.stdout, r.stderr)
              const wallTimeSeconds = ((yield* Clock.currentTimeMillis) - started) / 1000
              // The shape of OpenCode's own shell result (its declared output schema).
              return { output: { exitCode: r.exitCode, output, wallTimeSeconds }, content: [{ type: "text" as const, text: message(output, r.exitCode) }] }
            })
          }
        })
      )
      .pipe(Effect.asVoid)
  }
})
