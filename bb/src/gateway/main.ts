import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { makeGatewayHandler } from "../adapters/gateway/server.ts"
import { makeAgentSandboxes } from "../adapters/sandbox/agent-sandbox.ts"
import { makeLocalSandboxes } from "../adapters/sandbox/local.ts"
import type { Sandboxes } from "../ports/index.ts"

// The sandbox gateway: a sidecar next to celld in each bb pod (Bun). The Worker
// asks it, over HTTP on localhost, to open workspaces and run the agent's work in
// sandboxes (src/adapters/gateway/api.ts).
//
//   BB_GATEWAY_TOKEN       shared with the Worker (required)
//   BB_GATEWAY_PORT        default 8090
//   BB_GATEWAY_DIR         bb's copies of workspaces; default /var/lib/bb-gateway
//   BB_SANDBOX_BACKEND     agent-sandbox (default in a cluster) | local (no isolation)
//   BB_SANDBOX_NAMESPACE   default: the pod's namespace
//   BB_SANDBOX_WARM_POOL   default bb-sandbox
//   BB_SANDBOX_READY_TIMEOUT_MS  default 180000

const env = process.env
const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount"
const inCluster = env.KUBERNETES_SERVICE_HOST !== undefined

const token = env.BB_GATEWAY_TOKEN ?? ""
if (token === "") throw new Error("BB_GATEWAY_TOKEN is required")
const base = env.BB_GATEWAY_DIR || "/var/lib/bb-gateway"
const backend = env.BB_SANDBOX_BACKEND || (inCluster ? "agent-sandbox" : "local")

const agentSandbox = (): Sandboxes["Service"] => {
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
    execTimeoutMs: 600_000
  })
}

const sandboxes = backend === "agent-sandbox" ? agentSandbox() : backend === "local" ? makeLocalSandboxes(base) : undefined
if (!sandboxes) throw new Error(`unknown BB_SANDBOX_BACKEND "${backend}" (agent-sandbox | local)`)

const port = Number(env.BB_GATEWAY_PORT || 8090)
Bun.serve({ hostname: "0.0.0.0", port, fetch: makeGatewayHandler(sandboxes, token) })
Effect.runFork(Effect.log("bb gateway listening", { port, backend, base }))
