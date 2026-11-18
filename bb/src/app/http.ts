import { Context, Effect } from "effect"
import { protocolVersion } from "../domain/index.ts"
import { CellDirectory, type CellError, CellRejected } from "../ports/index.ts"
import * as front from "./front.ts"

// The bb contract over HTTP (docs/bb-contract.md). Plain Request -> Response, so it
// runs unchanged in celld (workerd) and in Bun.

export class FrontSettings extends Context.Service<
  FrontSettings,
  {
    /** Bearer token callers must present; empty disables auth (local dev only). */
    readonly token: string
    readonly version: string
  }
>()("bb/FrontSettings") {}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fromError = (e: CellError) =>
  e._tag === "CellRejected" ? json(e.status, { error: e.reason }) : json(503, { error: e.reason })

const taskRoute = /^\/tasks\/([^/]+)(\/events|\/cancel)?$/

/**
 * Builds the fetch handler. The handler is an edge: it runs each request's effect
 * with the services captured here.
 */
export const makeHandler = Effect.gen(function* () {
  const context = yield* Effect.context<CellDirectory | FrontSettings>()
  const settings = Context.get(context, FrontSettings)

  const route = (request: Request): Effect.Effect<Response, never, CellDirectory> => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Effect.succeed(json(200, { protocolVersion, version: settings.version }))
    }
    if (settings.token !== "" && request.headers.get("authorization") !== `Bearer ${settings.token}`) {
      return Effect.succeed(json(401, { error: "missing or wrong bearer token" }))
    }
    const match = taskRoute.exec(url.pathname)
    if (!match?.[1]) return Effect.succeed(json(404, { error: "not found" }))
    const taskId = decodeURIComponent(match[1])
    const sub = match[2]

    if (request.method === "PUT" && sub === undefined) {
      return Effect.tryPromise({
        try: (): Promise<unknown> => request.json(),
        catch: () => new CellRejected({ status: 400, reason: "body is not JSON" })
      }).pipe(
        Effect.flatMap((body) => front.submit(taskId, body)),
        Effect.map((result) => json(200, { ...result, protocolVersion })),
        Effect.catch((e) => Effect.succeed(fromError(e)))
      )
    }
    if (request.method === "GET" && sub === "/events") {
      const since = Number(url.searchParams.get("since") ?? request.headers.get("last-event-id") ?? 0)
      if (!Number.isInteger(since) || since < 0) return Effect.succeed(json(400, { error: "since must be a non-negative integer" }))
      return front.events(taskId, since).pipe(
        Effect.map(
          (body) =>
            new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
        ),
        Effect.catch((e) => Effect.succeed(fromError(e)))
      )
    }
    if (request.method === "POST" && sub === "/cancel") {
      return front.cancel(taskId).pipe(
        Effect.map((result) =>
          json(200, result._tag === "Tombstoned" ? { taskId: result.taskId, status: "cancelled", tombstoned: true } : result)
        ),
        Effect.catch((e) => Effect.succeed(fromError(e)))
      )
    }
    return Effect.succeed(json(405, { error: "method not allowed" }))
  }

  const runRequest = Effect.runPromiseWith(context)
  return (request: Request): Promise<Response> =>
    runRequest(
      route(request).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("unhandled request failure", cause).pipe(Effect.as(json(500, { error: "internal error" })))
        )
      )
    )
})
