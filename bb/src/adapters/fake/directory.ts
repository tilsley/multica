import { Context, Effect, Fiber } from "effect"
import * as cell from "../../app/cell.ts"
import { CellSettings } from "../../app/cell.ts"
import { toSse } from "../../app/sse.ts"
import {
  AgentRuntime,
  CellDirectory,
  type CellClient,
  CellStore,
  CellUnavailable,
  Mailbox,
  Scheduler
} from "../../ports/index.ts"
import { makeMemoryCellStore } from "./cell-store.ts"

// In-process cells: the same cell use cases that run inside a celld Durable Object,
// each with its own in-memory store and a scheduler that really runs its ticks.

export interface FakeCellsOptions {
  readonly runtime: AgentRuntime["Service"]
  readonly mailbox: Mailbox["Service"]
  readonly settings: CellSettings["Service"]
}

interface FakeCell {
  readonly client: CellClient
  readonly store: ReturnType<typeof makeMemoryCellStore>
  /** Kills in-memory work as an eviction would. The store and the pending wake survive. */
  readonly evict: () => void
}

export const makeFakeCells = (options: FakeCellsOptions) => {
  const cells = new Map<string, FakeCell>()
  /** Set while cells are "down": every call fails as if the node were unreachable. */
  const faults = { unavailable: false }

  const create = (taskId: string): FakeCell => {
    const store = makeMemoryCellStore(taskId)
    let pending: Fiber.Fiber<unknown, unknown> | undefined
    let wakeAt: number | undefined

    const schedule = (delayMs: number) => {
      if (pending) Effect.runFork(Fiber.interrupt(pending))
      wakeAt = Date.now() + delayMs
      pending = Effect.runFork(
        Effect.sleep(delayMs).pipe(
          Effect.andThen(Effect.sync(() => (wakeAt = undefined))),
          Effect.andThen(cell.tick()),
          Effect.catchCause((c) => Effect.logWarning("fake cell tick failed", c)),
          Effect.provideContext(context)
        )
      )
    }
    const scheduler: Scheduler["Service"] = {
      wakeIn: (delayMs) => Effect.sync(() => schedule(delayMs)),
      cancel: Effect.sync(() => {
        if (pending) Effect.runFork(Fiber.interrupt(pending))
        pending = undefined
        wakeAt = undefined
      })
    }
    const context = Context.make(CellStore, store.service).pipe(
      Context.add(Scheduler, scheduler),
      Context.add(AgentRuntime, options.runtime),
      Context.add(Mailbox, options.mailbox),
      Context.add(CellSettings, options.settings)
    )
    const run = <A, E>(effect: Effect.Effect<A, E, cell.CellServices>) =>
      Effect.suspend(
        (): Effect.Effect<A, E | CellUnavailable, cell.CellServices> =>
          faults.unavailable ? Effect.fail(new CellUnavailable({ reason: "fake cell unavailable" })) : effect
      ).pipe(Effect.provideContext(context))

    const client: CellClient = {
      put: (request, parentRunId) => run(cell.put(request, parentRunId)),
      describe: run(cell.describe),
      resolve: run(cell.resolve),
      cancel: run(cell.cancel()),
      events: (since) =>
        run(cell.events(since)).pipe(Effect.flatMap((stream) => toSse(stream).pipe(Effect.provideContext(context))))
    }
    const evict = () => {
      // An alarm is durable: re-arm it for its remaining time, as a restarted node would.
      if (pending) Effect.runFork(Fiber.interrupt(pending))
      pending = undefined
      if (wakeAt !== undefined) schedule(Math.max(0, wakeAt - Date.now()))
    }
    return { client, store, evict }
  }

  const get = (taskId: string) => {
    let c = cells.get(taskId)
    if (!c) {
      c = create(taskId)
      cells.set(taskId, c)
    }
    return c
  }

  const directory: CellDirectory["Service"] = { cell: (taskId) => get(taskId).client }
  return { directory, cells, get, faults }
}
