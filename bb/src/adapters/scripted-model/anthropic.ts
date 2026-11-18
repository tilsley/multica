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

/** The last user message's text, without the Multica brief bb prepends. */
const lastUserText = (body: unknown): string => {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return ""
  const user = body.messages.findLast((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user")
  const content: unknown = typeof user === "object" && user !== null && "content" in user ? user.content : ""
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: unknown) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n")
        : ""
  return text.replace(/<multica-runtime-brief>[\s\S]*?<\/multica-runtime-brief>\s*/g, "").trim()
}

/** How many user turns the conversation has so far: proves history reached the model. */
const userTurns = (body: unknown): number =>
  typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages)
    ? body.messages.filter((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user").length
    : 0

/** The scripted reply for a request: acknowledges the task in a stable, testable form. */
export const scriptedReply = (body: unknown): string => {
  const task = lastUserText(body).split("\n")[0]?.slice(0, 200) ?? ""
  return `bb (scripted model) received the task: "${task}" (turn ${userTurns(body)} of this conversation). With a real model I would clone the repository, make the change in a sandbox and open a pull request.`
}

const messageStream = (text: string, model: string) =>
  [
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_scripted", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
    }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: text.split(" ").length } }),
    frame("message_stop", { type: "message_stop" })
  ].join("")

/** Answers one Messages API request with the scripted reply (whatever host it was sent to). */
export const scriptedMessages = async (request: Request): Promise<Response> => {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages")) {
    return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "scripted model: only POST /v1/messages" } }), { status: 404 })
  }
  const body: unknown = await request.json()
  const model = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? body.model : "bb-scripted"
  return new Response(messageStream(scriptedReply(body), model), { headers: { "content-type": "text/event-stream" } })
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
