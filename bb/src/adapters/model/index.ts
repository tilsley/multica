import { Data, Result } from "effect"
import { scriptedFetch, scriptedHost, scriptedProvider } from "../scripted-model/anthropic.ts"

// Which model OpenCode talks to, chosen by configuration (BB_MODEL):
//   scripted  (default) the scripted stand-in: no network, no key, deterministic.
//   claude    Anthropic's Messages API with an API key (kind / local use).
// Both go through OpenCode's Anthropic-compatible provider, so bb's code is the
// same either way; only the provider settings and the outbound fetch differ.
// Bedrock (production, no keys) needs request signing outside the Worker and is
// a later mode: see docs/domain.md, "Models".

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ModelSettings {
  readonly BB_MODEL?: string | undefined
  readonly ANTHROPIC_API_KEY?: string | undefined
  /** Defaults to claude-opus-5-5. */
  readonly BB_CLAUDE_MODEL?: string | undefined
  /** Defaults to https://api.anthropic.com/v1 (a proxy that speaks the same API also works). */
  readonly ANTHROPIC_BASE_URL?: string | undefined
}

export interface ModelSetup {
  /** OpenCode `providers` config. */
  readonly providers: Record<string, { readonly name: string; readonly package: string; readonly settings: { readonly baseURL: string; readonly apiKey: string }; readonly models: Record<string, { readonly name: string }> }>
  /** OpenCode's default model, "provider/model". */
  readonly model: string
  /** The same model as a session's model reference. */
  readonly ref: { readonly providerID: string; readonly id: string }
  /** OpenCode's outbound fetch: only the model's host is reachable. */
  readonly fetch: Fetch
  /** For logs and /health: never includes the key. */
  readonly describe: string
}

export class ModelConfigError extends Data.TaggedError("ModelConfigError")<{ readonly reason: string }> {}

export const defaultClaudeModel = "claude-opus-5-5"
const defaultAnthropicBaseUrl = "https://api.anthropic.com/v1"

/** Outbound fetch that reaches only the given hosts and refuses everything else. */
export const egress = (routes: Readonly<Record<string, Fetch>>): Fetch => async (input, init) => {
  const request = new Request(input, init)
  const host = new URL(request.url).hostname
  const route = routes[host]
  return route ? route(request) : new Response(`bb: outbound request to ${host} refused`, { status: 403 })
}

const scripted: ModelSetup = {
  providers: scriptedProvider,
  model: "scripted/bb-scripted",
  ref: { providerID: "scripted", id: "bb-scripted" },
  fetch: egress({ [scriptedHost]: scriptedFetch }),
  describe: "scripted"
}

const claude = (settings: ModelSettings, upstream: Fetch): Result.Result<ModelSetup, ModelConfigError> => {
  const apiKey = settings.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return Result.fail(new ModelConfigError({ reason: "BB_MODEL=claude needs ANTHROPIC_API_KEY" }))
  const id = settings.BB_CLAUDE_MODEL?.trim() || defaultClaudeModel
  const baseURL = settings.ANTHROPIC_BASE_URL?.trim() || defaultAnthropicBaseUrl
  let host: string
  try {
    host = new URL(baseURL).hostname
  } catch {
    return Result.fail(new ModelConfigError({ reason: `ANTHROPIC_BASE_URL is not a URL: ${baseURL}` }))
  }
  return Result.succeed({
    providers: {
      claude: {
        name: "Claude",
        package: "@opencode/ai/providers/anthropic-compatible",
        settings: { baseURL, apiKey },
        models: { [id]: { name: id } }
      }
    },
    model: `claude/${id}`,
    ref: { providerID: "claude", id },
    fetch: egress({ [host]: upstream }),
    describe: `claude (${id} via ${host})`
  })
}

/** The model setup for these settings. `upstream` is the real network (globalThis.fetch). */
export const modelSetup = (settings: ModelSettings, upstream: Fetch): Result.Result<ModelSetup, ModelConfigError> => {
  const mode = settings.BB_MODEL?.trim() || "scripted"
  if (mode === "scripted") return Result.succeed(scripted)
  if (mode === "claude") return claude(settings, upstream)
  return Result.fail(new ModelConfigError({ reason: `unknown BB_MODEL "${mode}" (scripted | claude)` }))
}
