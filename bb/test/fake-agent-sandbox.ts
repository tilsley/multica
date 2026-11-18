import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { frame, unframe } from "../src/adapters/sandbox/grpc.ts"

// A pretend cluster for the agent-sandbox adapter: a Kubernetes API that knows
// SandboxClaims and Sandboxes, and one sandboxd per sandbox (REST files + gRPC
// Execute over h2c) on its own loopback address, 127.0.0.N, serving a temp dir
// as /workspace. Paths under /workspace in commands are mapped to that dir.

const restPort = 18_480
const grpcPort = 18_490

// --- protobuf, the server side (the adapter has the client side) ---------------
const readMessage = (bytes: Uint8Array) => {
  const fields: Array<{ no: number; value: Uint8Array | number }> = []
  let at = 0
  const varint = () => {
    let r = 0
    let s = 0
    for (;;) {
      const b = bytes[at++] ?? 0
      r |= (b & 0x7f) << s
      s += 7
      if ((b & 0x80) === 0) return r
    }
  }
  while (at < bytes.length) {
    const tag = varint()
    if ((tag & 7) === 0) fields.push({ no: tag >>> 3, value: varint() })
    else {
      const len = varint()
      fields.push({ no: tag >>> 3, value: bytes.slice(at, at + len) })
      at += len
    }
  }
  return fields
}
const varintBytes = (n: number) => {
  const out: Array<number> = []
  let v = n >>> 0
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}
const encodeResponse = (exitCode: number, stdout: Uint8Array, stderr: Uint8Array) =>
  new Uint8Array([8, ...varintBytes(exitCode), 18, ...varintBytes(stdout.length), ...stdout, 26, ...varintBytes(stderr.length), ...stderr])
const text = (b: Uint8Array | number) => (typeof b === "number" ? String(b) : new TextDecoder().decode(b))

class FakeSandboxd {
  readonly root = mkdtempSync(join(tmpdir(), "bb-fake-sandboxd-"))
  private readonly rest: ReturnType<typeof Bun.serve>
  private readonly grpc: Http2Server
  constructor(readonly ip: string) {
    this.rest = Bun.serve({ hostname: ip, port: restPort, fetch: (r) => this.files(r) })
    this.grpc = createServer()
    this.grpc.on("stream", (stream: ServerHttp2Stream) => {
      const chunks: Array<Buffer> = []
      stream.on("data", (c: Buffer) => chunks.push(c))
      stream.on("end", () => {
        const config = readMessage(unframe(new Uint8Array(Buffer.concat(chunks)))).find((f) => f.no === 1)?.value
        const fields = config instanceof Uint8Array ? readMessage(config) : []
        const map = (s: string) => s.replaceAll("/workspace", this.root)
        const argv = fields.filter((f) => f.no === 1).map((f) => map(text(f.value)))
        const env: Record<string, string> = { PATH: process.env.PATH ?? "" }
        for (const f of fields.filter((x) => x.no === 2)) {
          const kv = f.value instanceof Uint8Array ? readMessage(f.value) : []
          env[text(kv.find((x) => x.no === 1)?.value ?? 0)] = text(kv.find((x) => x.no === 2)?.value ?? 0)
        }
        const cwd = map(text(fields.find((f) => f.no === 3)?.value ?? new TextEncoder().encode("/workspace")))
        const r = spawnSync(argv[0] ?? "true", argv.slice(1), { cwd, env })
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true })
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }))
        stream.end(frame(encodeResponse(r.status ?? 1, new Uint8Array(r.stdout), new Uint8Array(r.stderr))))
      })
    })
    this.grpc.listen(grpcPort, ip)
  }
  private async files(r: Request): Promise<Response> {
    const url = new URL(r.url)
    const path = join(this.root, decodeURIComponent(url.pathname.replace(/^\/v1\/files\/?/, "")))
    const isFile = () => { try { return statSync(path).isFile() } catch { return false } }
    if (r.method === "HEAD") return new Response(null, { status: isFile() ? 200 : 404 })
    if (r.method === "GET") return isFile() ? new Response(readFileSync(path)) : new Response("{}", { status: 404 })
    if (r.method === "DELETE") { rmSync(path, { force: true, recursive: true }); return new Response(null, { status: 204 }) }
    if (r.method === "PUT") {
      const body = new Uint8Array(await r.arrayBuffer())
      if (url.searchParams.get("extract") === "tar") {
        mkdirSync(path, { recursive: true })
        const x = spawnSync("tar", ["-x", "-C", path], { input: body })
        return new Response(null, { status: x.status === 0 ? 204 : 400 })
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 405 })
  }
  stop() {
    void this.rest.stop(true)
    this.grpc.close()
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const nameOf = (body: unknown): string => {
  const metadata = typeof body === "object" && body !== null && "metadata" in body ? body.metadata : undefined
  const name = typeof metadata === "object" && metadata !== null && "name" in metadata ? metadata.name : undefined
  return typeof name === "string" ? name : ""
}

/** The pretend cluster. `kubeFetch` is the Kubernetes API; sandboxes appear Ready at once. */
export const makeFakeCluster = (namespace = "bb") => {
  const claims = new Map<string, FakeSandboxd>()
  let next = 2
  const kubeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const r = new Request(input, init)
    if (r.headers.get("authorization") !== "Bearer kube-token") return json(401, { message: "unauthorized" })
    const path = new URL(r.url).pathname
    const claim = new RegExp(`^/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${namespace}/sandboxclaims(?:/([^/]+))?$`).exec(path)
    const sandbox = new RegExp(`^/apis/agents.x-k8s.io/v1beta1/namespaces/${namespace}/sandboxes/([^/]+)$`).exec(path)
    if (claim && r.method === "POST") {
      const body: unknown = await r.json()
      const name = nameOf(body)
      if (claims.has(name)) return json(409, { reason: "AlreadyExists" })
      claims.set(name, new FakeSandboxd(`127.0.0.${next++}`))
      return json(201, body)
    }
    const name = claim?.[1] ?? sandbox?.[1]
    const box = name ? claims.get(name) : undefined
    if (claim?.[1] && r.method === "DELETE") {
      box?.stop()
      claims.delete(claim[1])
      return json(box ? 200 : 404, {})
    }
    if (!box) return json(404, { reason: "NotFound" })
    if (claim) return json(200, { status: { sandbox: { name } } })
    return json(200, { status: { podIPs: [box.ip], conditions: [{ type: "Ready", status: "True" }] } })
  }
  return { kubeFetch, restPort, grpcPort, claims: () => claims.size, stop: () => { for (const b of claims.values()) b.stop() } }
}
