// A scripted model that speaks Anthropic's Messages API (streaming), served to
// OpenCode through its `fetch` hook: no network, no key, deterministic. Because
// it speaks the same wire format as Claude, switching to the real model only
// changes the provider's base URL and key (AI=claude), not bb's code.

export const scriptedHost = "scripted.bb.internal"

/** OpenCode `providers` config for the scripted model. */
export const scriptedProvider = {
  scripted: {
    name: "bb scripted model",
    package: "@opencode/ai/providers/anthropic-compatible",
    settings: { baseURL: `https://${scriptedHost}/v1`, apiKey: "scripted" },
    models: { "bb-scripted": { name: "bb scripted" } }
  }
} as const

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

const messagesOf = (body: unknown): ReadonlyArray<unknown> => (isObject(body) && Array.isArray(body.messages) ? body.messages : [])

/** A user message's own text (tool results are not text the user wrote). */
const userText = (m: unknown): string => {
  if (!isObject(m) || m.role !== "user") return ""
  const content = m.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((c: unknown) => (isObject(c) && c.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n")
}

/** The last user text, without the Multica brief bb prepends. */
const lastUserText = (body: unknown): string => {
  const text = messagesOf(body).map(userText).findLast((t) => t.trim() !== "") ?? ""
  return text.replace(/<multica-runtime-brief>[\s\S]*?<\/multica-runtime-brief>\s*/g, "").trim()
}

/** How many user turns the conversation has so far: proves history reached the model. */
const userTurns = (body: unknown): number => messagesOf(body).filter((m) => userText(m).trim() !== "").length

/** The text of the tool results in the last message, if it carries any. */
const toolResults = (body: unknown): string | undefined => {
  const last = messagesOf(body).at(-1)
  if (!isObject(last) || last.role !== "user" || !Array.isArray(last.content)) return undefined
  const results: Array<unknown> = last.content.filter((c: unknown) => isObject(c) && c.type === "tool_result")
  if (results.length === 0) return undefined
  const text = (c: unknown): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map(text).join("") : isObject(c) && typeof c.text === "string" ? c.text : ""
  return results.map((r) => (isObject(r) ? text(r.content) : "")).join("\n")
}

/**
 * A tool call the task asks the scripted model to make, from its first directive line:
 *   run: <command>   OpenCode's shell
 *   glob: <pattern>  OpenCode's glob
 *   grep: <pattern>  OpenCode's grep
 */
const scriptedCall = (body: unknown): { readonly tool: string; readonly input: Record<string, string>; readonly said: string } | undefined => {
  const m = /^(run|glob|grep): (.+)$/m.exec(lastUserText(body))
  const arg = m?.[2]?.trim()
  if (!m || !arg) return undefined
  if (m[1] === "run") return { tool: "shell", input: { command: arg }, said: `Ran \`${arg}\`` }
  if (m[1] === "glob") return { tool: "glob", input: { pattern: arg }, said: `Files matching \`${arg}\`` }
  return { tool: "grep", input: { pattern: arg }, said: `Matches for \`${arg}\`` }
}

/** The scripted reply for a request: acknowledges the task in a stable, testable form. */
export const scriptedReply = (body: unknown): string => {
  const task = lastUserText(body).split("\n")[0]?.slice(0, 200) ?? ""
  return `bb (scripted model) received the task: "${task}" (turn ${userTurns(body)} of this conversation). With a real model I would clone the repository, make the change in a sandbox and open a pull request.`
}

const start = (model: string) =>
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_scripted", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
  })
const stop = (reason: string, tokens: number) =>
  frame("message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: tokens } }) +
  frame("message_stop", { type: "message_stop" })

const messageStream = (text: string, model: string) =>
  [
    start(model),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    stop("end_turn", text.split(" ").length)
  ].join("")

/** One call of an OpenCode tool. */
const toolStream = (tool: string, input: Record<string, string>, model: string) =>
  [
    start(model),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_scripted", name: tool, input: {} } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    stop("tool_use", 10)
  ].join("")

/** What the scripted model says next: make the task's tool call first, then report it. */
const scriptedTurn = (body: unknown, model: string): string => {
  const call = scriptedCall(body)
  const output = toolResults(body)
  if (call !== undefined && output === undefined) return toolStream(call.tool, call.input, model)
  if (call !== undefined && output !== undefined) return messageStream(`${call.said}:\n${output.trim()}`, model)
  return messageStream(scriptedReply(body), model)
}

/** Answers one Messages API request with the scripted reply (whatever host it was sent to). */
export const scriptedMessages = async (request: Request): Promise<Response> => {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages")) {
    return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "scripted model: only POST /v1/messages" } }), { status: 404 })
  }
  const body: unknown = await request.json()
  const model = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? body.model : "bb-scripted"
  return new Response(scriptedTurn(body, model), { headers: { "content-type": "text/event-stream" } })
}

/**
 * OpenCode's outbound fetch: the scripted model answers its host; everything
 * else is refused (no egress until a real model is configured).
 */
export const scriptedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname === scriptedHost) return scriptedMessages(request)
  return new Response(`bb: outbound request to ${new URL(request.url).hostname} refused`, { status: 403 })
}
