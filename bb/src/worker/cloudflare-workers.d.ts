// Ambient type for the runtime module celld (like workerd) provides to Workers.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: unknown
    protected readonly env: Env
    constructor(ctx: unknown, env: Env)
  }
}
