import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { makeGatewayHandler } from "../adapters/gateway/server.ts"
import { type AgentSandboxes, makeAgentSandboxes } from "../adapters/sandbox/agent-sandbox.ts"
import { defaultGit, type GitSettings } from "../adapters/sandbox/git.ts"
import { releaseWhenIdle } from "../adapters/sandbox/idle.ts"
import { makeLocalSandboxes } from "../adapters/sandbox/local.ts"
import type { Sandboxes } from "../ports/index.ts"

// The sandbox gateway (Bun; its own Deployment). The bb Worker asks it over HTTP
// to open workspaces, run the agent's work in sandboxes, copy changes back and
// publish them as pull requests (src/adapters/gateway/api.ts).
//
//   BB_GATEWAY_TOKEN       shared with the Worker (required)
//   BB_GATEWAY_PORT        default 8090
//   BB_GATEWAY_DIR         bb's copies of workspaces; default /var/lib/bb-gateway
//   BB_SANDBOX_BACKEND     agent-sandbox (default in a cluster) | local (no isolation)
//   BB_SANDBOX_NAMESPACE   default: the pod's namespace
//   BB_SANDBOX_WARM_POOL   default bb-sandbox
//   BB_SANDBOX_READY_TIMEOUT_MS  default 180000
//   BB_GATEWAY_LOG         1 to log every request (method, path, status, time)
//   BB_SANDBOX_IDLE_MINUTES  give an idle workspace's sandbox back after this; default 30
//   GITHUB_TOKEN           optional: clone private github.com repositories, push the
//                          workspace's branch and open pull requests
//   BB_GIT_AUTHOR_NAME / BB_GIT_AUTHOR_EMAIL   who bb commits as; default bb <bb@localhost>

const env = process.env
const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount"
const inCluster = env.KUBERNETES_SERVICE_HOST !== undefined

const token = env.BB_GATEWAY_TOKEN ?? ""
if (token === "") throw new Error("BB_GATEWAY_TOKEN is required")
const base = env.BB_GATEWAY_DIR || "/var/lib/bb-gateway"
const backend = env.BB_SANDBOX_BACKEND || (inCluster ? "agent-sandbox" : "local")
const git: GitSettings = {
  ...defaultGit,
  githubToken: env.GITHUB_TOKEN?.trim() || undefined,
  author: { name: env.BB_GIT_AUTHOR_NAME || defaultGit.author.name, email: env.BB_GIT_AUTHOR_EMAIL || defaultGit.author.email }
}

const agentSandbox = (): AgentSandboxes => {
  if (!inCluster) throw new Error("BB_SANDBOX_BACKEND=agent-sandbox needs to run in a Kubernetes pod")
  const ca = readFileSync(`${serviceAccount}/ca.crt`, "utf8")
  // Bun's fetch takes the cluster CA per request.
  const kubeInit = (init?: RequestInit): RequestInit & { readonly tls: { readonly ca: string } } => ({ ...init, tls: { ca } })
  return makeAgentSandboxes({
    base,
    namespace: env.BB_SANDBOX_NAMESPACE || readFileSync(`${serviceAccount}/namespace`, "utf8").trim(),
    warmPool: env.BB_SANDBOX_WARM_POOL || "bb-sandbox",
    kube: {
      url: `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? "443"}`,
      fetch: (input, init) => fetch(input, kubeInit(init)),
      // Re-read each time: the projected token rotates.
      token: async () => readFileSync(`${serviceAccount}/token`, "utf8").trim()
    },
    sandboxd: { restPort: 8080, grpcPort: 9090, token: env.BB_SANDBOXD_TOKEN || undefined },
    readyTimeoutMs: Number(env.BB_SANDBOX_READY_TIMEOUT_MS || 180_000),
    pollMs: 1000,
    execTimeoutMs: 600_000,
    git
  })
}

const chosen: { readonly sandboxes: Sandboxes["Service"]; readonly existing?: () => Promise<ReadonlyArray<string>> } | undefined =
  backend === "agent-sandbox"
    ? (() => {
        const a = agentSandbox()
        return { sandboxes: a, existing: a.claimed }
      })()
    : backend === "local"
      ? { sandboxes: makeLocalSandboxes(base, git) }
      : undefined
if (!chosen) throw new Error(`unknown BB_SANDBOX_BACKEND "${backend}" (agent-sandbox | local)`)

const idleMinutes = Number(env.BB_SANDBOX_IDLE_MINUTES || 30)
const idle = releaseWhenIdle(chosen.sandboxes, { idleMs: idleMinutes * 60_000, now: () => Date.now(), existing: chosen.existing })
const sandboxes = idle.sandboxes
// Claims from before a restart count as just used, so they are reaped later too.
Effect.runFork(
  idle.adopt.pipe(
    Effect.tap((n) => Effect.log("tracking sandboxes already claimed", { count: n })),
    Effect.catch((e) => Effect.logWarning("could not list existing sandboxes", { reason: e.reason }))
  )
)
setInterval(() => {
  Effect.runFork(idle.reap.pipe(Effect.tap((keys) => (keys.length > 0 ? Effect.log("gave idle sandboxes back", { keys }) : Effect.void))))
}, 60_000)

// Kubernetes "service links" set BB_GATEWAY_PORT=tcp://… in pods when a Service is
// named bb-gateway (deploy/k8s/bb-gateway.yaml turns them off); refuse anything
// but a number rather than listen on NaN.
const portSetting = env.BB_GATEWAY_PORT || "8090"
if (!/^\d+$/.test(portSetting)) throw new Error(`BB_GATEWAY_PORT must be a port number, got "${portSetting}"`)
const port = Number(portSetting)
const handler = makeGatewayHandler(sandboxes, token)
const logged = async (request: Request) => {
  const started = performance.now()
  const response = await handler(request)
  const { pathname } = new URL(request.url)
  Effect.runFork(Effect.log("request", { method: request.method, path: pathname, status: response.status, ms: Math.round(performance.now() - started) }))
  return response
}
Bun.serve({ hostname: "0.0.0.0", port, fetch: env.BB_GATEWAY_LOG === "1" ? logged : handler })
Effect.runFork(Effect.log("bb gateway listening", { port, backend, base, github: git.githubToken ? "token set" : "no token", idleMinutes }))
