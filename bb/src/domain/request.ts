import { Schema } from "effect"

// The body of PUT /tasks/{id} (docs/bb-contract.md).

export const protocolVersion = 1

const Repo = Schema.Struct({
  url: Schema.String,
  ref: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String)
})

export const TaskRequest = Schema.Struct({
  protocolVersion: Schema.Literal(protocolVersion),
  taskId: Schema.NonEmptyString,
  multicaTaskId: Schema.optionalKey(Schema.String),
  retryOf: Schema.optionalKey(Schema.String),
  attempt: Schema.optionalKey(Schema.Int),
  prompt: Schema.NonEmptyString,
  systemPrompt: Schema.optionalKey(Schema.String),
  resumeSessionId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(
    Schema.Struct({ id: Schema.optionalKey(Schema.String), identifier: Schema.optionalKey(Schema.String) })
  ),
  chatSessionId: Schema.optionalKey(Schema.String),
  repos: Schema.optionalKey(Schema.Array(Repo)),
  multica: Schema.optionalKey(
    Schema.Struct({
      serverUrl: Schema.optionalKey(Schema.String),
      workspaceId: Schema.optionalKey(Schema.String),
      taskToken: Schema.optionalKey(Schema.String)
    })
  )
})
export type TaskRequest = typeof TaskRequest.Type
