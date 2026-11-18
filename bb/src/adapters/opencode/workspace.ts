import { EnvironmentFiles, WorkspaceDriver } from "@opencode/sdk/effect"
import { Effect, PlatformError, Sink, Stream } from "effect"
import type { ChildProcess } from "effect/process"
import * as Spawner from "effect/process/ChildProcessSpawner"
import type { Sandboxes } from "../../ports/index.ts"
import { sandboxShellPlugin } from "./sandbox-shell.ts"

// OpenCode's workspace provider over bb's Sandboxes port: every process OpenCode
// starts in a session located in this workspace (its shell tool, and the commands
// behind its file tools) runs in the sandbox, and file reads and writes go to the
// sandbox's files. The workspace id is the Sandboxes key; bb opens the workspace
// (clone, claim, copy in) before OpenCode first connects to it.
//
// effect/process is marked unstable; OpenCode's driver interface is built on it,
// so this file (and only this file) accepts that:
// @effect-diagnostics unstableApiUsage:off
//
// Limits: a process's output arrives when it exits (no streaming), and stdin is
// supported only as a stream given when the command is made (not written later).

export const providerName = "bb"

type Driver = Effect.Success<ReturnType<WorkspaceDriver.Interface["connect"]>>

const failed = (method: string, e: { readonly reason: string }) =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method, description: e.reason })

const stdinOf = (options: ChildProcess.CommandOptions): Effect.Effect<Uint8Array | undefined, PlatformError.PlatformError> => {
  const input = typeof options.stdin === "object" && options.stdin !== null && "stream" in options.stdin ? options.stdin.stream : options.stdin
  if (input === undefined || typeof input === "string") return Effect.undefined
  return Stream.runCollect(input).pipe(
    Effect.map((chunks) => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    })
  )
}

const envOf = (options: ChildProcess.CommandOptions): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (typeof v === "string") env[k] = v
  }
  return env
}

const spawnerFor = (sandboxes: Sandboxes["Service"], key: string) =>
  Spawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") {
        return yield* PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "piped commands are not supported in a sandbox" })
      }
      const stdin = yield* stdinOf(command.options)
      const result = yield* sandboxes
        .exec(key, { argv: [command.command, ...command.args.map(String)], cwd: command.options.cwd, env: envOf(command.options), stdin })
        .pipe(Effect.mapError((e) => failed("spawn", e)))
      const out = Stream.make(result.stdout)
      const err = Stream.make(result.stderr)
      return Spawner.makeHandle({
        pid: Spawner.ProcessId(1),
        exitCode: Effect.succeed(Spawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: out,
        stderr: err,
        all: Stream.concat(out, err),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )

const fileFailed = (path: string) => (e: { readonly reason: string }) => new EnvironmentFiles.Failed({ path, cause: new Error(e.reason) })

const driverFor = (sandboxes: Sandboxes["Service"], key: string): Driver => ({
  spawner: spawnerFor(sandboxes, key),
  overrides: {
    read: (path, range) =>
      sandboxes.readFile(key, path).pipe(
        Effect.mapError(fileFailed(path)),
        Effect.filterOrFail((bytes): bytes is Uint8Array => bytes !== undefined, () => new EnvironmentFiles.NotFound({ path })),
        Effect.map((bytes) => ({
          info: { type: "file" as const, size: bytes.length, mtimeMs: 0 },
          bytes: range ? bytes.subarray(range.offset, range.offset + range.length) : bytes
        }))
      ),
    write: (path, bytes) => sandboxes.writeFile(key, path, bytes).pipe(Effect.mapError(fileFailed(path))),
    append: (path, bytes) =>
      sandboxes.readFile(key, path).pipe(
        Effect.flatMap((before) => {
          const all = new Uint8Array((before?.length ?? 0) + bytes.length)
          if (before) all.set(before)
          all.set(bytes, before?.length ?? 0)
          return sandboxes.writeFile(key, path, all)
        }),
        Effect.mapError(fileFailed(path))
      )
  }
})

const driverError = (e: { readonly reason: string }) => new WorkspaceDriver.Error({ message: e.reason })

/** The provider to register with OpenCode as `workspaceProviders: { bb: … }`. */
export const sandboxWorkspaceProvider = (sandboxes: Sandboxes["Service"]): WorkspaceDriver.Interface =>
  WorkspaceDriver.make({
    create: ({ workspaceID }) => Effect.succeed({ binding: { key: workspaceID } }),
    connect: ({ workspaceID }) => Effect.succeed(driverFor(sandboxes, workspaceID)),
    // The sandbox stays claimed while the workspace exists (bb releases it).
    suspendForIdle: () => Effect.void,
    destroy: ({ workspaceID }) => sandboxes.release(workspaceID).pipe(Effect.mapError(driverError))
  })

/** Everything an OpenCode host needs to run sessions in bb's sandboxes. */
export const sandboxHostOptions = (sandboxes: Sandboxes["Service"]) => ({
  workspaceProviders: { [providerName]: sandboxWorkspaceProvider(sandboxes) },
  plugins: [sandboxShellPlugin(sandboxes)]
})
