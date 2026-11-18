// The slice of the Cloudflare Durable Objects API bb uses, as implemented by celld
// (https://celld.dev/docs/services/durable-objects). Kept local so bb does not
// depend on the full workers-types package.

export interface SqlCursor<T> {
  toArray(): Array<T>
}

export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: Array<unknown>): SqlCursor<T>
}

export interface DurableObjectStorage {
  readonly sql: SqlStorage
  transactionSync<T>(fn: () => T): T
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
  getAlarm(): Promise<number | null>
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespace<Stub = DurableObjectStub> {
  getByName(name: string): Stub
}
