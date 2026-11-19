import { Effect } from "effect"
import { type Sandboxes, SandboxError } from "../../ports/index.ts"

// Sandboxes are expensive and a conversation can go quiet for days. This wraps
// any Sandboxes adapter: it remembers when each workspace was last used, and
// `reap` copies an idle workspace's sandbox back into bb's copy and gives the
// sandbox back. A workspace used again after that is opened again first (from
// bb's copy), so callers never see the difference.

export interface IdleOptions {
  readonly idleMs: number
  readonly now: () => number
  /** Workspaces that already hold a sandbox (e.g. claims found after a restart). */
  readonly existing?: (() => Promise<ReadonlyArray<string>>) | undefined
}

export interface IdleSandboxes {
  readonly sandboxes: Sandboxes["Service"]
  /** Syncs and releases every workspace idle for longer than `idleMs`; returns their keys. */
  readonly reap: Effect.Effect<ReadonlyArray<string>>
  /** Starts tracking workspaces that already hold a sandbox, as just used. */
  readonly adopt: Effect.Effect<number, SandboxError>
}

export const releaseWhenIdle = (inner: Sandboxes["Service"], options: IdleOptions): IdleSandboxes => {
  /** Workspaces with a sandbox, and when each was last used. */
  const open = new Map<string, number>()
  const touch = (key: string) => Effect.sync(() => open.set(key, options.now()))
  /** Reopens a workspace whose sandbox was given back (bb's copy has its repositories). */
  const ensure = (key: string) => (open.has(key) ? Effect.void : inner.open({ key, repos: [] }).pipe(Effect.asVoid))
  const using = <A>(key: string, f: () => Effect.Effect<A, SandboxError>) =>
    ensure(key).pipe(Effect.andThen(touch(key)), Effect.andThen(f()), Effect.tap(() => touch(key)))

  const sandboxes: Sandboxes["Service"] = {
    open: (spec) => inner.open(spec).pipe(Effect.tap(() => touch(spec.key))),
    exec: (key, request) => using(key, () => inner.exec(key, request)),
    readFile: (key, path) => using(key, () => inner.readFile(key, path)),
    writeFile: (key, path, bytes) => using(key, () => inner.writeFile(key, path, bytes)),
    sync: (key) => using(key, () => inner.sync(key)),
    // bb's copy only: no sandbox needed.
    publish: (key, request) => inner.publish(key, request),
    release: (key) => inner.release(key).pipe(Effect.tap(() => Effect.sync(() => open.delete(key))))
  }

  const reap = Effect.gen(function* () {
    const cutoff = options.now() - options.idleMs
    const idle = [...open].filter(([, at]) => at < cutoff).map(([key]) => key)
    const released: Array<string> = []
    for (const key of idle) {
      // Never give a sandbox back with work bb's copy does not have.
      const done = yield* inner.sync(key).pipe(
        Effect.andThen(inner.release(key)),
        Effect.as(true),
        Effect.catch((e) => Effect.logWarning("idle sandbox kept: could not sync and release it", { key, reason: e.reason }).pipe(Effect.as(false)))
      )
      if (done) {
        open.delete(key)
        released.push(key)
      }
    }
    return released
  })

  const adopt = Effect.tryPromise({
    try: async () => (options.existing ? await options.existing() : []),
    catch: (e) => new SandboxError({ reason: e instanceof Error ? e.message : String(e), retryable: true })
  }).pipe(
    Effect.tap((keys) => Effect.sync(() => keys.forEach((k) => open.has(k) || open.set(k, options.now())))),
    Effect.map((keys) => keys.length)
  )

  return { sandboxes, reap, adopt }
}
