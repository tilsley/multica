import { Effect, Schema } from "effect"
import type { Sandboxes, SandboxError } from "../../ports/index.ts"
import * as Api from "./api.ts"

// The gateway's HTTP side: serves ./api.ts over any Sandboxes adapter (local or
// agent-sandbox). A plain fetch handler, so tests call it in-process.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const failure = (e: SandboxError) => json(e.retryable ? 503 : 422, { error: e.reason, retryable: e.retryable })

const route = /^\/v1\/workspaces\/([^/]+)(\/(exec|read|write|sync|publish))?$/

const respond = <A, I, IE, O, OE>(
  request: Request,
  input: Schema.Codec<I, IE>,
  run: (value: I) => Effect.Effect<A, SandboxError>,
  output: Schema.Codec<O, OE>,
  shape: (a: A) => O
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      // A route without a body reads as {}.
      const body: unknown = yield* Effect.tryPromise({
        try: async () => {
          const text = await request.text()
          return text === "" ? {} : JSON.parse(text)
        },
        catch: () => "body is not JSON"
      })
      const value = yield* Schema.decodeUnknownEffect(input)(body).pipe(Effect.mapError((e) => `bad request: ${e.message}`))
      const result = yield* run(value)
      return json(200, yield* Schema.encodeEffect(output)(shape(result)).pipe(Effect.orDie))
    }).pipe(
      Effect.catch((e) => Effect.succeed(typeof e === "string" ? json(400, { error: e, retryable: false }) : failure(e)))
    )
  )

export const makeGatewayHandler = (sandboxes: Sandboxes["Service"], token: string) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/health") return json(200, { status: "ok" })
    if (request.headers.get("authorization") !== `Bearer ${token}`) return json(401, { error: "unauthorized", retryable: false })
    const match = route.exec(url.pathname)
    if (!match?.[1]) return json(404, { error: "not found", retryable: false })
    const key = decodeURIComponent(match[1])
    const action = match[3]
    const m = request.method
    if (action === undefined && m === "PUT")
      return respond(request, Api.OpenRequest, (v) => sandboxes.open({ key, repos: v.repos }), Api.OpenResponse, (r) => r)
    if (action === undefined && m === "DELETE") return respond(request, Api.Empty, () => sandboxes.release(key), Api.Empty, () => ({}))
    if (action === "exec" && m === "POST") return respond(request, Api.ExecRequest, (v) => sandboxes.exec(key, v), Api.ExecResponse, (r) => r)
    if (action === "read" && m === "POST")
      return respond(request, Api.ReadRequest, (v) => sandboxes.readFile(key, v.path), Api.ReadResponse, (data) => (data === undefined ? {} : { data }))
    if (action === "write" && m === "POST") return respond(request, Api.WriteRequest, (v) => sandboxes.writeFile(key, v.path, v.data), Api.Empty, () => ({}))
    if (action === "sync" && m === "POST") return respond(request, Api.Empty, () => sandboxes.sync(key), Api.SyncResponse, (r) => r)
    if (action === "publish" && m === "POST")
      return respond(
        request,
        Api.PublishRequest,
        (v) => sandboxes.publish(key, v),
        Api.PublishResponse,
        (published) => ({
          published: published.map((p) => ({
            repo: p.repo,
            branch: p.branch,
            ...(p.pullRequest === undefined ? {} : { pullRequest: p.pullRequest }),
            ...(p.created === undefined ? {} : { created: p.created })
          }))
        })
      )
    return json(405, { error: "method not allowed", retryable: false })
  }
}
