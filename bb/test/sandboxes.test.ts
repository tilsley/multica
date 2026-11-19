import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { afterAll, expect, it } from "vitest"
import { makeGatewaySandboxes } from "../src/adapters/gateway/client.ts"
import { makeGatewayHandler } from "../src/adapters/gateway/server.ts"
import { claimName, makeAgentSandboxes } from "../src/adapters/sandbox/agent-sandbox.ts"
import { defaultGit } from "../src/adapters/sandbox/git.ts"
import { makeLocalSandboxes } from "../src/adapters/sandbox/local.ts"
import { makeFakeCluster } from "./fake-agent-sandbox.ts"
import { sandboxesContract } from "./sandboxes-contract.ts"

const base = () => mkdtempSync(join(tmpdir(), "bb-sandboxes-"))

sandboxesContract("local", async () => makeLocalSandboxes(base()))

/** The Worker's view: the gateway client, over HTTP, to a gateway serving local sandboxes. */
const viaGateway = (token = "t0ken", clientToken = token) => {
  const handler = makeGatewayHandler(makeLocalSandboxes(base()), token)
  return makeGatewaySandboxes({ url: "http://gateway.test", token: clientToken, fetch: async (input, init) => handler(new Request(input, init)) })
}

sandboxesContract("gateway client → gateway → local", async () => viaGateway())

it("the gateway refuses a request without its token, and says it will not get better by retrying", async () => {
  const exit = await Effect.runPromiseExit(viaGateway("right", "wrong").open({ key: "wrk_auth", repos: [] }))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(JSON.stringify(exit)).toContain("unauthorized")
  expect(JSON.stringify(exit)).toContain('"retryable":false')
})

const cluster = makeFakeCluster()
afterAll(() => cluster.stop())
sandboxesContract("agent-sandbox (fake cluster)", async () =>
  makeAgentSandboxes({
    base: base(),
    namespace: "bb",
    warmPool: "bb-sandbox",
    kube: { url: "https://kube.test", fetch: cluster.kubeFetch, token: async () => "kube-token" },
    sandboxd: { restPort: cluster.restPort, grpcPort: cluster.grpcPort },
    readyTimeoutMs: 5000,
    pollMs: 10,
    execTimeoutMs: 10_000,
    git: defaultGit
  })
)

it("claim names are valid Kubernetes names and differ per key", () => {
  const a = claimName("wrk_bb_Task-1")
  expect(a).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/)
  expect(claimName("wrk_bb_task-1")).not.toBe(a)
  expect(claimName("x".repeat(200)).length).toBeLessThanOrEqual(63)
})
