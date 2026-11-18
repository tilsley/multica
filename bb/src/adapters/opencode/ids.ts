import { AbsolutePath, Event, Model, Session, SessionMessage, Workspace } from "@opencode/sdk/effect"
import { Effect, Schema } from "effect"
import { RuntimeError } from "../../ports/index.ts"

// OpenCode's ids are branded and validated (e.g. session ids start with "ses").
// bb derives them from its own ids; an invalid one is a bug, not worth retrying.

const invalid = (what: string, value: unknown) => () => new RuntimeError({ reason: `invalid OpenCode ${what}: ${String(value)}`, retryable: false })

export const sessionID = (s: string) => Session.ID.makeEffect(s).pipe(Effect.mapError(invalid("session id", s)))
export const messageID = (s: string) => SessionMessage.ID.makeEffect(s).pipe(Effect.mapError(invalid("message id", s)))
export const workspaceID = (s: string) => Workspace.ID.makeEffect(s).pipe(Effect.mapError(invalid("workspace id", s)))
export const seq = (n: number) => Event.Seq.makeEffect(n).pipe(Effect.mapError(invalid("event seq", n)))
export const absolutePath = (s: string) => AbsolutePath.makeEffect(s).pipe(Effect.mapError(invalid("path", s)))
const decodeModelRef = Schema.decodeUnknownEffect(Model.Ref)
export const modelRef = (m: { readonly providerID: string; readonly id: string }) =>
  decodeModelRef(m).pipe(Effect.mapError(invalid("model", `${m.providerID}/${m.id}`)))
