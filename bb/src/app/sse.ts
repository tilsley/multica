import { Stream } from "effect"
import type { LogEntry } from "../domain/index.ts"

// Server-sent events framing for a run's log (docs/bb-contract.md): the SSE `id`
// is the entry's sequence number, so a client resumes with ?since=<id> or
// Last-Event-ID.

const encoder = new TextEncoder()

export const frame = (entry: LogEntry): Uint8Array => {
  const { at: _at, ...wire } = entry
  return encoder.encode(`id: ${entry.id}\nevent: ${entry.kind}\ndata: ${JSON.stringify(wire)}\n\n`)
}

/** Encodes a log stream as SSE bytes. Runs the stream with the caller's services. */
export const toSse = <E, R>(entries: Stream.Stream<LogEntry, E, R>) =>
  Stream.toReadableStreamEffect(entries.pipe(Stream.map(frame), Stream.orDie))
