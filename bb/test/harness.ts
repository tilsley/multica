import { Context, Effect, Schema } from "effect"
import { makeFakeCells } from "../src/adapters/fake/directory.ts"
import { makeMemoryMailbox } from "../src/adapters/fake/mailbox.ts"
import { defaultScript, makeScriptedRuntime, type Script } from "../src/adapters/fake/runtime.ts"
import { FrontSettings, makeHandler } from "../src/app/http.ts"
import { CellDirectory, type TaskSummary } from "../src/ports/index.ts"

export const token = "test-token"

type Json = Record<string, unknown>
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

/** bb in-process: the real HTTP handler, front and cell use cases over fake adapters. */
export const makeStack = async (script: Partial<Script> = {}) => {
  const runtime = makeScriptedRuntime({ ...defaultScript, stepDelayMs: 20, heartbeatEveryMs: 30, ...script })
  const mailbox = makeMemoryMailbox()
  const cells = makeFakeCells({
    runtime: runtime.service,
    mailbox: mailbox.service,
    settings: { tickMs: 10, pollMs: 50 }
  })
  const context = Context.make(CellDirectory, cells.directory).pipe(
    Context.add(FrontSettings, { token, version: "test" })
  )
  const handler = await Effect.runPromise(makeHandler.pipe(Effect.provideContext(context)))

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`http://bb.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )

  const put = async (taskId: string, extra: Record<string, unknown> = {}) => {
    const res = await call("PUT", `/tasks/${taskId}`, { protocolVersion: 1, taskId, prompt: "fix it", ...extra })
    return { status: res.status, body: decodeObject(await res.json()) }
  }

  /** Reads an SSE stream to its end (or `limit` events). */
  const events = async (taskId: string, since = 0, limit = Infinity) => {
    const res = await call("GET", `/tasks/${taskId}/events?since=${since}`)
    if (res.status !== 200 || !res.body) return { status: res.status, events: [] as Array<Json> }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const out: Array<Json> = []
    while (out.length < limit) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let i: number
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        const data = frame.split("\n").find((l) => l.startsWith("data: "))
        if (data) out.push(decodeObject(JSON.parse(data.slice(6))))
      }
    }
    await reader.cancel()
    return { status: 200, events: out }
  }

  const summaries = (): ReadonlyArray<TaskSummary> => [...mailbox.rows.values()]
  return { handler, call, put, events, cells, runtime: runtime.control, mailbox, summaries }
}
