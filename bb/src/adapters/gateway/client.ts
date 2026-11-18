import { Effect, Schema } from "effect"
import { type Sandboxes, SandboxError } from "../../ports/index.ts"
import * as Api from "./api.ts"

// Sandboxes over the gateway's HTTP API: what the bb Worker uses in celld (fetch
// is all it has). See ./api.ts and ./server.ts.

export interface GatewayClientOptions {
  /** e.g. http://127.0.0.1:8090 (the sidecar in the same pod). */
  readonly url: string
  readonly token: string
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const decodeError = Schema.decodeUnknownOption(Api.ErrorBody)

export const makeGatewaySandboxes = (options: GatewayClientOptions): Sandboxes["Service"] => {
  const call = <I, IE, O, OE>(
    method: string,
    key: string,
    path: string,
    input: { readonly schema: Schema.Codec<I, IE>; readonly value: I } | undefined,
    output: Schema.Codec<O, OE>
  ) =>
    Effect.gen(function* () {
      const body = input ? JSON.stringify(yield* Schema.encodeEffect(input.schema)(input.value).pipe(Effect.orDie)) : undefined
      const url = `${options.url.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(key)}${path}`
      const response = yield* Effect.tryPromise({
        try: () => options.fetch(url, { method, headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body }) }),
        catch: (e) => new SandboxError({ reason: `gateway unreachable: ${e instanceof Error ? e.message : String(e)}`, retryable: true })
      })
      const json: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new SandboxError({ reason: `gateway answered ${response.status} without JSON`, retryable: response.status >= 500 })
      })
      if (!response.ok) {
        const err = decodeError(json)
        return yield* new SandboxError(
          err._tag === "Some" ? { reason: err.value.error, retryable: err.value.retryable } : { reason: `gateway answered ${response.status}`, retryable: response.status >= 500 }
        )
      }
      return yield* Schema.decodeUnknownEffect(output)(json).pipe(Effect.mapError((e) => new SandboxError({ reason: `bad gateway response: ${e.message}`, retryable: false })))
    })

  return {
    open: (spec) =>
      call("PUT", spec.key, "", { schema: Api.OpenRequest, value: { repos: spec.repos.map((r) => (r.ref ? { url: r.url, ref: r.ref } : { url: r.url })) } }, Api.OpenResponse),
    exec: (key, r) =>
      call(
        "POST",
        key,
        "/exec",
        {
          schema: Api.ExecRequest,
          value: {
            argv: r.argv,
            ...(r.cwd === undefined ? {} : { cwd: r.cwd }),
            ...(r.env === undefined ? {} : { env: r.env }),
            ...(r.stdin === undefined ? {} : { stdin: r.stdin }),
            ...(r.timeoutMs === undefined ? {} : { timeoutMs: r.timeoutMs })
          }
        },
        Api.ExecResponse
      ),
    readFile: (key, path) =>
      call("POST", key, "/read", { schema: Api.ReadRequest, value: { path } }, Api.ReadResponse).pipe(Effect.map((r) => r.data)),
    writeFile: (key, path, data) =>
      call("POST", key, "/write", { schema: Api.WriteRequest, value: { path, data } }, Api.Empty).pipe(Effect.asVoid),
    sync: (key) => call("POST", key, "/sync", undefined, Api.SyncResponse),
    release: (key) => call("DELETE", key, "", undefined, Api.Empty).pipe(Effect.asVoid)
  }
}
