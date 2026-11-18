import { DurableObject } from "cloudflare:workers"
import { Context, Effect, Exit } from "effect"
import * as cell from "../app/cell.ts"
import { CellSettings } from "../app/cell.ts"
import { FrontSettings, makeHandler } from "../app/http.ts"
import { toSse } from "../app/sse.ts"
import { makeDurableCell } from "../adapters/durable-object/cell.ts"
import { type ControlRpc, controlMailbox, makeControl } from "../adapters/durable-object/control.ts"
import { durableDirectory, type Outcome, type TaskCellRpc } from "../adapters/durable-object/directory.ts"
import type { DurableObjectNamespace, DurableObjectState } from "../adapters/durable-object/types.ts"
import { defaultScript, makeScriptedRuntime } from "../adapters/fake/runtime.ts"
import { adminState, brokenBody, cutAfter, decodeTestConfig, scriptOf } from "../adapters/testkit/faults.ts"
import { AgentRuntime, CellDirectory, type CellError, CellStore, Mailbox, Scheduler } from "../ports/index.ts"

// celld composition root: the Worker (front door) and the TaskCell / Control
// Durable Object classes. Configuration comes from wrangler `vars`.

export interface Env {
  readonly TASKS: DurableObjectNamespace<TaskCellRpc>
  readonly CONTROL: DurableObjectNamespace<ControlRpc>
  readonly BB_TOKEN?: string
  readonly BB_VERSION?: string
  /** "1" enables mock-bb-compatible /admin endpoints and fault injection. Tests only. */
  readonly BB_TEST_ADMIN?: string
  readonly BB_TICK_MS?: string
}

const testMode = (env: Env) => env.BB_TEST_ADMIN === "1"
const control = (env: Env) => env.CONTROL.getByName("control")

type CellState = DurableObjectState & { readonly id: { readonly name?: string } }

export class TaskCell extends DurableObject<Env> implements TaskCellRpc {
  private readonly context: Context.Context<cell.CellServices>

  constructor(state: CellState, env: Env) {
    super(state, env)
    const taskId = state.id.name ?? "unknown"
    const { store, scheduler } = makeDurableCell(state, taskId)
    // The scripted agent stands in for OpenCode until that adapter lands; in test
    // mode its script comes from /admin/config, as mock-bb's does.
    const script = testMode(env)
      ? Effect.promise(() => control(env).faults()).pipe(Effect.map((f) => scriptOf(f.config)))
      : Effect.succeed(defaultScript)
    const runtime = makeScriptedRuntime(defaultScript, script)
    this.context = Context.make(CellStore, store).pipe(
      Context.add(Scheduler, scheduler),
      Context.add(AgentRuntime, runtime.service),
      Context.add(Mailbox, controlMailbox(env.CONTROL)),
      Context.add(CellSettings, { tickMs: Number(env.BB_TICK_MS ?? 1000), pollMs: 10_000 })
    )
  }

  private run<A>(effect: Effect.Effect<A, CellError, cell.CellServices>): Promise<Outcome<A>> {
    return Effect.runPromiseExitWith(this.context)(effect).then((exit): Outcome<A> => {
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
      const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
      if (failure?._tag === "Fail") {
        const e = failure.error
        return e._tag === "CellRejected" ? { ok: false, status: e.status, reason: e.reason } : { ok: false, status: 503, reason: e.reason }
      }
      return { ok: false, status: 503, reason: "cell failed unexpectedly" }
    })
  }

  put(request: Parameters<TaskCellRpc["put"]>[0], parentRunId: string | undefined) {
    return this.run(cell.put(request, parentRunId))
  }
  describe() {
    return this.run(cell.describe)
  }
  resolve() {
    return this.run(cell.resolve)
  }
  cancel() {
    return this.run(cell.cancel())
  }
  async alarm() {
    await Effect.runPromiseWith(this.context)(
      cell.tick().pipe(Effect.catchCause((c) => Effect.logError("tick failed; the next alarm retries", c)))
    )
  }
  async fetch(request: Request): Promise<Response> {
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0)
    const out = await this.run(cell.events(since).pipe(Effect.flatMap(toSse)))
    if (!out.ok) return new Response(out.reason, { status: out.status })
    return new Response(out.value, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  }
}

export class Control extends DurableObject<Env> implements ControlRpc {
  private readonly impl: ControlRpc
  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.impl = makeControl(state)
  }
  record(...a: Parameters<ControlRpc["record"]>) { return this.impl.record(...a) }
  list() { return this.impl.list() }
  faults() { return this.impl.faults() }
  configure(...a: Parameters<ControlRpc["configure"]>) { return this.impl.configure(...a) }
  judge(...a: Parameters<ControlRpc["judge"]>) { return this.impl.judge(...a) }
  reset() { return this.impl.reset() }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const admin = async (request: Request, env: Env, path: string): Promise<Response> => {
  const c = control(env)
  if (path === "/admin/state") return json(200, adminState(await c.list(), (await c.faults()).config))
  if (path === "/admin/reset" && request.method === "POST") {
    await c.reset()
    return json(200, { status: "reset" })
  }
  if (path === "/admin/config") {
    if (request.method === "POST") return json(200, (await c.configure(decodeTestConfig(await request.json()))).config)
    return json(200, (await c.faults()).config)
  }
  return json(404, { error: "not found" })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const context = Context.make(CellDirectory, durableDirectory(env.TASKS)).pipe(
      Context.add(FrontSettings, { token: env.BB_TOKEN ?? "", version: env.BB_VERSION ?? "dev" })
    )
    const handler = await Effect.runPromise(makeHandler.pipe(Effect.provideContext(context)))
    const path = new URL(request.url).pathname
    if (!testMode(env) || path === "/health") return handler(request)
    if (path.startsWith("/admin/")) return admin(request, env, path)

    const verdict = await control(env).judge(request.method === "PUT")
    if (verdict._tag === "Fail") return json(503, { error: "bb: injected failure (test mode)" })
    const response = await handler(request)
    if (verdict.dropReply) return new Response(brokenBody(), { status: 200 })
    if (verdict.dropAfter > 0 && response.body && response.headers.get("content-type") === "text/event-stream") {
      return new Response(cutAfter(response.body, verdict.dropAfter), response)
    }
    return response
  }
}
