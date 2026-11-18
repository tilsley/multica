import { Result } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { absent, type AgentEvent, type Command, decide, type LogEntry, type Task, type TaskRequest } from "../src/domain/index.ts"

const request: TaskRequest = { protocolVersion: 1, taskId: "t1", prompt: "do it" }

const event: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.constant<AgentEvent>({ kind: "heartbeat" }),
  fc.string().map((text): AgentEvent => ({ kind: "text", text })),
  fc.string().map((text): AgentEvent => ({ kind: "thought", text })),
  fc.constantFrom<AgentEvent>(
    { kind: "result", status: "succeeded", summary: "ok" },
    { kind: "result", status: "failed", error: "no" },
    { kind: "result", status: "cancelled" }
  )
)

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.constant<Command>({ _tag: "Create", request, sessionId: "s", now: 1 }),
  fc.constant<Command>({ _tag: "AliasTo", runId: "other", now: 1 }),
  fc.constant<Command>({ _tag: "Cancel", now: 1 }),
  fc.array(event, { maxLength: 5 }).map((events): Command => ({ _tag: "Record", events, cursor: "c", now: 1 }))
)

/** Runs commands from Absent, keeping the log the cell would have stored. */
const play = (commands: ReadonlyArray<Command>) => {
  let task: Task = absent("t1")
  const log: Array<LogEntry> = []
  const history: Array<{ before: Task; command: Command; after: Task; appended: number }> = []
  for (const c of commands) {
    const r = decide(task, c)
    if (Result.isSuccess(r)) {
      history.push({ before: task, command: c, after: r.success.task, appended: r.success.appended.length })
      log.push(...r.success.appended)
      task = r.success.task
    }
  }
  return { task, log, history }
}

const commands = fc.array(command, { maxLength: 40 })

describe("domain invariants (docs/domain.md)", () => {
  it("1. contiguous log: event ids are 1, 2, 3 … with no gaps or reuse", () => {
    fc.assert(fc.property(commands, (cs) => {
      const { log } = play(cs)
      expect(log.map((e) => e.id)).toEqual(log.map((_, i) => i + 1))
    }))
  })

  it("2. closed after result: at most one result, and it is last", () => {
    fc.assert(fc.property(commands, (cs) => {
      const { log } = play(cs)
      const results = log.filter((e) => e.kind === "result")
      expect(results.length).toBeLessThanOrEqual(1)
      if (results.length === 1) expect(log.at(-1)?.kind).toBe("result")
    }))
  })

  it("3. idempotent create: Create/AliasTo on an existing task changes nothing", () => {
    fc.assert(fc.property(commands, (cs) => {
      for (const h of play(cs).history) {
        const creating = h.command._tag === "Create" || h.command._tag === "AliasTo"
        if (creating && (h.before._tag === "Run" || h.before._tag === "Alias")) {
          expect(h.after).toBe(h.before)
          expect(h.appended).toBe(0)
        }
      }
    }))
  })

  it("4. tombstones are final", () => {
    fc.assert(fc.property(commands, (cs) => {
      for (const h of play(cs).history) {
        if (h.before._tag === "Tombstone") expect(h.after._tag).toBe("Tombstone")
      }
    }))
  })

  it("5. aliases have no log", () => {
    fc.assert(fc.property(commands, (cs) => {
      const { task, log, history } = play(cs)
      if (task._tag === "Alias") expect(log).toEqual([])
      for (const h of history) if (h.before._tag === "Alias") expect(h.appended).toBe(0)
    }))
  })

  it("6. status matches the log", () => {
    fc.assert(fc.property(commands, (cs) => {
      const { task, log } = play(cs)
      if (task._tag !== "Run") return
      const result = log.find((e) => e.kind === "result")
      expect(task.status).toBe(result && result.kind === "result" ? result.status : "running")
      expect(task.lastSeq).toBe(log.length)
    }))
  })
})

describe("decide examples", () => {
  it("refuses to create a tombstoned task", () => {
    const tomb = decide(absent("t1"), { _tag: "Cancel", now: 1 })
    expect(Result.isSuccess(tomb) && tomb.success.task._tag).toBe("Tombstone")
    if (!Result.isSuccess(tomb)) return
    const again = decide(tomb.success.task, { _tag: "Create", request, sessionId: "s", now: 2 })
    expect(Result.isFailure(again) && again.failure._tag).toBe("Tombstoned")
  })

  it("a result always carries the run's session", () => {
    const created = decide(absent("t1"), { _tag: "Create", request, sessionId: "s7", now: 1 })
    if (!Result.isSuccess(created)) throw new Error("create failed")
    const r = decide(created.success.task, { _tag: "Record", events: [{ kind: "result", status: "succeeded" }], cursor: "c", now: 2 })
    expect(Result.isSuccess(r) && r.success.appended[0]).toMatchObject({ kind: "result", sessionId: "s7" })
  })

  it("drops events after a result in the same batch", () => {
    const created = decide(absent("t1"), { _tag: "Create", request, sessionId: "s", now: 1 })
    if (!Result.isSuccess(created)) throw new Error("create failed")
    const r = decide(created.success.task, {
      _tag: "Record",
      events: [{ kind: "text", text: "a" }, { kind: "result", status: "succeeded" }, { kind: "text", text: "late" }],
      cursor: "c",
      now: 2
    })
    expect(Result.isSuccess(r) && r.success.appended.map((e) => e.kind)).toEqual(["text", "result"])
  })

  it("cancelling a running run appends a cancelled result carrying the session", () => {
    const created = decide(absent("t1"), { _tag: "Create", request, sessionId: "s1", now: 1 })
    if (!Result.isSuccess(created)) throw new Error("create failed")
    const r = decide(created.success.task, { _tag: "Cancel", now: 2 })
    expect(Result.isSuccess(r) && r.success.appended).toEqual([
      { kind: "result", status: "cancelled", sessionId: "s1", id: 1, at: 2 }
    ])
  })
})
