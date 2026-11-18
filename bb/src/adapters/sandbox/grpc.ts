import { connect, constants } from "node:http2"

// Just enough gRPC to call sandboxd's ProcessService.Execute (unary), with the
// protobuf messages encoded by hand: sandboxd has no REST exec, and the Worker's
// gateway needs nothing else from gRPC.
//
//   message ProcessConfig  { repeated string command = 1; map<string,string> env_vars = 2; optional string cwd = 3; }
//   message ExecuteRequest { ProcessConfig config = 1; }
//   message ExecuteResponse { int32 exit_code = 1; bytes stdout = 2; bytes stderr = 3; }

const utf8 = new TextEncoder()

const varint = (n: number): Array<number> => {
  const out: Array<number> = []
  let v = n >>> 0
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

const field = (no: number, bytes: Uint8Array): Array<number> => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes]
const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface ExecuteRequest {
  readonly command: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly cwd?: string | undefined
}

export const encodeExecuteRequest = (r: ExecuteRequest): Uint8Array => {
  const config: Array<number> = []
  for (const c of r.command) config.push(...field(1, utf8.encode(c)))
  for (const [k, v] of Object.entries(r.env ?? {})) config.push(...field(2, new Uint8Array([...field(1, utf8.encode(k)), ...field(2, utf8.encode(v))])))
  if (r.cwd !== undefined) config.push(...field(3, utf8.encode(r.cwd)))
  return new Uint8Array(field(1, new Uint8Array(config)))
}

export interface ExecuteResponse {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

export const decodeExecuteResponse = (bytes: Uint8Array): ExecuteResponse => {
  let at = 0
  const readVarint = () => {
    let result = 0
    let shift = 0
    for (;;) {
      const b = bytes[at++]
      if (b === undefined) throw new Error("truncated protobuf")
      if (shift < 32) result |= (b & 0x7f) << shift
      shift += 7
      if ((b & 0x80) === 0) return result
    }
  }
  let exitCode = 0
  let stdout = new Uint8Array()
  let stderr = new Uint8Array()
  while (at < bytes.length) {
    const tag = readVarint()
    const no = tag >>> 3
    const type = tag & 7
    if (type === 0) {
      const v = readVarint()
      if (no === 1) exitCode = v | 0
    } else if (type === 2) {
      const len = readVarint()
      const value = bytes.slice(at, at + len)
      at += len
      if (no === 2) stdout = value
      if (no === 3) stderr = value
    } else throw new Error(`unsupported protobuf wire type ${type}`)
  }
  return { exitCode, stdout, stderr }
}

/** gRPC length-prefixed message framing. */
export const frame = (message: Uint8Array) => {
  const out = new Uint8Array(5 + message.length)
  new DataView(out.buffer).setUint32(1, message.length)
  out.set(message, 5)
  return out
}

export const unframe = (body: Uint8Array): Uint8Array => {
  if (body.length < 5) throw new Error("empty gRPC response")
  if (body[0] !== 0) throw new Error("compressed gRPC responses are not supported")
  const len = new DataView(body.buffer, body.byteOffset).getUint32(1)
  return body.slice(5, 5 + len)
}

/** Calls ProcessService.Execute on sandboxd's gRPC port (h2c). */
export const execute = (
  authority: string,
  request: ExecuteRequest,
  options: { readonly timeoutMs: number; readonly token?: string | undefined }
): Promise<ExecuteResponse> =>
  new Promise((resolve, reject) => {
    const session = connect(`http://${authority}`)
    const done = (f: () => void) => {
      session.close()
      f()
    }
    session.on("error", (e) => done(() => reject(e)))
    const stream = session.request({
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: "/process.v1.ProcessService/Execute",
      "content-type": "application/grpc",
      te: "trailers",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    })
    stream.setTimeout(options.timeoutMs, () => {
      stream.close(constants.NGHTTP2_CANCEL)
      done(() => reject(new Error(`command timed out after ${options.timeoutMs}ms`)))
    })
    const chunks: Array<Uint8Array> = []
    let status: string | undefined
    let message = ""
    stream.on("response", (headers) => {
      if (headers["grpc-status"] !== undefined) status = String(headers["grpc-status"])
    })
    stream.on("trailers", (trailers) => {
      status = String(trailers["grpc-status"] ?? status ?? "")
      message = decodeURIComponent(String(trailers["grpc-message"] ?? ""))
    })
    stream.on("data", (c: Uint8Array) => chunks.push(c))
    stream.on("error", (e) => done(() => reject(e)))
    stream.on("end", () =>
      done(() => {
        if (status !== "0") return reject(new Error(`sandboxd Execute failed (grpc-status ${status ?? "missing"}): ${message}`))
        try {
          resolve(decodeExecuteResponse(unframe(concat(chunks))))
        } catch (e) {
          reject(e)
        }
      })
    )
    stream.end(frame(encodeExecuteRequest(request)))
  })
