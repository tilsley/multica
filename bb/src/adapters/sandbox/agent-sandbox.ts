import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { type ExecRequest, type Sandboxes, SandboxError } from "../../ports/index.ts"
import { cloneInto, run } from "./git.ts"
import { execute } from "./grpc.ts"
import { syncTree } from "./tree.ts"

// Sandboxes on kubernetes-sigs/agent-sandbox. bb's copy of a workspace lives on
// the gateway's disk (<base>/copies/<key>); the sandbox is a SandboxClaim from a
// warm pool, running sandboxd: files over its REST API (:8080), commands over
// its gRPC ProcessService (:9090), both rooted at /workspace.
//
//   open     clone into bb's copy; claim (a claim named after the key: creating
//            it again adopts it); wait for Ready; copy bb's copy in as a tar
//            archive unless the sandbox already has it (marker .bb/ready).
//   sync     `tar -c` in the sandbox, unpack on the gateway, then make bb's copy
//            match (syncTree; .git and .bb never come back).
//   release  delete the claim. bb's copy stays.
//
// Nothing about a workspace is kept in the gateway's memory that cannot be found
// again in the cluster, so a restarted gateway carries on.

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface AgentSandboxOptions {
  /** The gateway's own disk: bb's copies. */
  readonly base: string
  readonly namespace: string
  readonly warmPool: string
  readonly kube: { readonly url: string; readonly fetch: Fetch; readonly token: () => Promise<string> }
  readonly sandboxd: { readonly restPort: number; readonly grpcPort: number; readonly token?: string | undefined }
  readonly readyTimeoutMs: number
  readonly pollMs: number
  readonly execTimeoutMs: number
}

export const sandboxRoot = "/workspace"
const marker = ".bb/ready"
const claims = "/apis/extensions.agents.x-k8s.io/v1beta1"
const sandboxesApi = "/apis/agents.x-k8s.io/v1beta1"

/** A Kubernetes name for the key: lowercase RFC 1123, ≤ 63, unique per key. */
export const claimName = (key: string) => {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8)
  const base = key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  return `bb-${base}-${hash}`.replace(/-+/g, "-")
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const at = (v: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>((o, k) => (Array.isArray(o) && typeof k === "number" ? o[k] : isObject(o) && typeof k === "string" ? o[k] : undefined), v)
const conditionTrue = (obj: unknown, type: string) => {
  const conditions = at(obj, "status", "conditions")
  return Array.isArray(conditions) && conditions.some((c) => at(c, "type") === type && at(c, "status") === "True")
}
const notReadyReason = (obj: unknown) => {
  const conditions = at(obj, "status", "conditions")
  const ready = Array.isArray(conditions) ? conditions.find((c) => at(c, "type") === "Ready") : undefined
  const reason = ready && at(ready, "status") === "False" ? at(ready, "reason") : undefined
  return typeof reason === "string" ? reason : undefined
}
/** Claim reasons that will not get better by waiting (from the agent-sandbox client). */
const terminal = new Set(["InvalidMetadata", "EnvVarsInjectionRejected", "VolumeClaimTemplatesError", "ClaimExpired", "SandboxExpired", "InvalidConfiguration", "PodFailed", "PodSucceeded", "TemplateNotFound", "WarmPoolNotFound"])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

class Retryable extends Error {}

const inRoot = (path: string): string | undefined => {
  if (!path.startsWith("/")) return path
  if (path === sandboxRoot) return ""
  return path.startsWith(`${sandboxRoot}/`) ? path.slice(sandboxRoot.length + 1) : undefined
}

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => new SandboxError({ reason: message(e), retryable: e instanceof Retryable }) })

export const makeAgentSandboxes = (options: AgentSandboxOptions): Sandboxes["Service"] => {
  const copy = (key: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error(`bad workspace key: ${key}`)
    return join(options.base, "copies", key)
  }

  const kube = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const response = await options.kube.fetch(`${options.kube.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${await options.kube.token()}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text === "" ? undefined : JSON.parse(text)
    } catch {
      json = text
    }
    if (response.status >= 500 || response.status === 429) throw new Retryable(`kubernetes ${method} ${path}: ${response.status}`)
    return { status: response.status, json }
  }

  const claimPath = (name = "") => `${claims}/namespaces/${options.namespace}/sandboxclaims${name ? `/${name}` : ""}`

  /** The sandbox pod's address, claiming it first if needed. */
  const claim = async (key: string): Promise<string> => {
    const name = claimName(key)
    const created = await kube("POST", claimPath(), {
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxClaim",
      metadata: { name, labels: { "app.kubernetes.io/managed-by": "bb" }, annotations: { "bb/workspace": key } },
      spec: { warmPoolRef: { name: options.warmPool } }
    })
    if (created.status === 404) throw new Error(`agent-sandbox is not installed (no SandboxClaim API): ${JSON.stringify(created.json)}`)
    if (created.status >= 400 && created.status !== 409) throw new Error(`creating SandboxClaim ${name}: ${created.status} ${JSON.stringify(created.json)}`)
    const deadline = Date.now() + options.readyTimeoutMs
    const poll = async (): Promise<string> => {
      if (Date.now() >= deadline) throw new Retryable(`SandboxClaim ${name} not ready after ${options.readyTimeoutMs}ms`)
      const c = await kube("GET", claimPath(name))
      const reason = notReadyReason(c.json)
      if (reason && terminal.has(reason)) throw new Error(`SandboxClaim ${name} failed: ${reason}`)
      const sandbox = at(c.json, "status", "sandbox", "name")
      if (typeof sandbox === "string" && sandbox !== "") {
        const s = await kube("GET", `${sandboxesApi}/namespaces/${options.namespace}/sandboxes/${sandbox}`)
        const ip = at(s.json, "status", "podIPs", 0)
        if (conditionTrue(s.json, "Ready") && typeof ip === "string") return ip
      }
      await sleep(options.pollMs)
      return poll()
    }
    return poll()
  }

  // Addresses are cached; a miss (or a gateway restart) finds the claim again.
  const addresses = new Map<string, string>()
  const address = async (key: string, open = false): Promise<string> => {
    const known = addresses.get(key)
    if (known) return known
    if (!open) {
      const c = await kube("GET", claimPath(claimName(key)))
      if (c.status === 404) throw new Error(`workspace ${key} is not open`)
    }
    const ip = await claim(key)
    addresses.set(key, ip)
    return ip
  }

  const files = async (key: string, method: string, rel: string, query = "", body?: Uint8Array) => {
    const ip = await address(key)
    const path = rel.split("/").filter((s) => s !== "").map(encodeURIComponent).join("/")
    const response = await fetch(`http://${ip}:${options.sandboxd.restPort}/v1/files/${path}${query}`, {
      method,
      headers: { ...(options.sandboxd.token ? { authorization: `Bearer ${options.sandboxd.token}` } : {}), ...(body ? { "content-type": "application/octet-stream" } : {}) },
      ...(body ? { body: new Uint8Array(body) } : {})
    })
    if (response.status >= 500) throw new Retryable(`sandboxd ${method} ${rel}: ${response.status}`)
    return response
  }

  const exec = async (key: string, request: ExecRequest) => {
    const ip = await address(key)
    let argv = [...request.argv]
    let staged: string | undefined
    if (request.stdin && request.stdin.length > 0) {
      // Execute has no stdin: stage it as a file and redirect.
      staged = `.bb/stdin-${randomUUID()}`
      const w = await files(key, "PUT", staged, "?parents=true", request.stdin)
      if (!w.ok) throw new Error(`staging stdin: ${w.status}`)
      argv = ["sh", "-c", `exec "$0" "$@" < ${sandboxRoot}/${staged}`, ...argv]
    }
    try {
      return await execute(`${ip}:${options.sandboxd.grpcPort}`, { command: argv, env: request.env, cwd: request.cwd ?? sandboxRoot }, { timeoutMs: request.timeoutMs ?? options.execTimeoutMs, token: options.sandboxd.token })
    } finally {
      if (staged) await files(key, "DELETE", staged).catch(() => undefined)
    }
  }

  return {
    open: (spec) =>
      attempt(async () => {
        const dir = copy(spec.key)
        await cloneInto(dir, spec)
        await address(spec.key, true)
        const ready = await files(spec.key, "HEAD", marker)
        if (ready.status !== 200) {
          const tar = await run(["tar", "-c", "-C", dir, "."], { cwd: dir, timeoutMs: 300_000 })
          if (tar.exitCode !== 0) throw new Error(`tar of bb's copy failed: ${new TextDecoder().decode(tar.stderr)}`)
          const put = await files(spec.key, "PUT", "", "?extract=tar", tar.stdout)
          if (!put.ok) throw new Error(`copying the workspace into the sandbox: ${put.status} ${await put.text()}`)
          const done = await files(spec.key, "PUT", marker, "?parents=true", new TextEncoder().encode("ok"))
          if (!done.ok) throw new Error(`marking the sandbox ready: ${done.status}`)
        }
        return { root: sandboxRoot }
      }),
    exec: (key, request) => attempt(() => exec(key, request)),
    readFile: (key, path) =>
      attempt(async () => {
        const rel = inRoot(path)
        if (rel === undefined) {
          const r = await exec(key, { argv: ["sh", "-c", 'test -f "$1" || exit 44; cat "$1"', "sh", path] })
          if (r.exitCode === 44) return undefined
          if (r.exitCode !== 0) throw new Error(`reading ${path}: ${new TextDecoder().decode(r.stderr)}`)
          return r.stdout
        }
        const r = await files(key, "GET", rel, "?type=file")
        if (r.status === 404) return undefined
        if (!r.ok) throw new Error(`reading ${path}: ${r.status} ${await r.text()}`)
        return new Uint8Array(await r.arrayBuffer())
      }),
    writeFile: (key, path, bytes) =>
      attempt(async () => {
        const rel = inRoot(path)
        if (rel === undefined) {
          const r = await exec(key, { argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], stdin: bytes })
          if (r.exitCode !== 0) throw new Error(`writing ${path}: ${new TextDecoder().decode(r.stderr)}`)
          return
        }
        const r = await files(key, "PUT", rel, "?parents=true", bytes)
        if (!r.ok) throw new Error(`writing ${path}: ${r.status} ${await r.text()}`)
      }),
    sync: (key) =>
      attempt(async () => {
        const r = await exec(key, { argv: ["tar", "-c", "-C", sandboxRoot, "--exclude=./.git", "--exclude=*/.git", "--exclude=./.bb", "."] })
        if (r.exitCode !== 0) throw new Error(`tar in the sandbox failed: ${new TextDecoder().decode(r.stderr)}`)
        const unpacked = await mkdtemp(join(tmpdir(), "bb-sync-"))
        try {
          const x = await run(["tar", "-x", "-C", unpacked], { cwd: unpacked, stdin: r.stdout, timeoutMs: 300_000 })
          if (x.exitCode !== 0) throw new Error(`unpacking the sandbox's tree failed: ${new TextDecoder().decode(x.stderr)}`)
          return { changed: await syncTree(unpacked, copy(key)) }
        } finally {
          await rm(unpacked, { recursive: true, force: true })
        }
      }),
    release: (key) =>
      attempt(async () => {
        addresses.delete(key)
        const r = await kube("DELETE", claimPath(claimName(key)))
        if (r.status >= 400 && r.status !== 404) throw new Error(`deleting the SandboxClaim: ${r.status} ${JSON.stringify(r.json)}`)
      })
  }
}
