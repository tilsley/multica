import { Schema } from "effect"

// The sandbox gateway's HTTP API: the bb Worker (which cannot touch a disk, git
// or the Kubernetes API) asks the gateway sidecar in its pod to do Sandboxes
// operations. JSON both ways; bytes are base64. Every route is under
// /v1/workspaces/{key}; errors are { error, retryable } with a 4xx/5xx status.

export const Repo = Schema.Struct({ url: Schema.String, ref: Schema.optionalKey(Schema.String) })
export const OpenRequest = Schema.Struct({ repos: Schema.Array(Repo) })
export const OpenResponse = Schema.Struct({
  root: Schema.String,
  repos: Schema.Array(Schema.Struct({ url: Schema.String, path: Schema.String }))
})

export const ExecRequest = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  stdin: Schema.optionalKey(Schema.Uint8ArrayFromBase64),
  timeoutMs: Schema.optionalKey(Schema.Int)
})
export const ExecResponse = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.Uint8ArrayFromBase64,
  stderr: Schema.Uint8ArrayFromBase64
})

export const ReadRequest = Schema.Struct({ path: Schema.String })
export const ReadResponse = Schema.Struct({ data: Schema.optionalKey(Schema.Uint8ArrayFromBase64) })
export const WriteRequest = Schema.Struct({ path: Schema.String, data: Schema.Uint8ArrayFromBase64 })
export const SyncResponse = Schema.Struct({ changed: Schema.Array(Schema.String) })
export const Empty = Schema.Struct({})
export const ErrorBody = Schema.Struct({ error: Schema.String, retryable: Schema.Boolean })


