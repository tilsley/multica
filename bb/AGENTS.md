# bb

bb runs coding tasks for the Multica daemon: OpenCode inside celld Durable Objects (one cell per task), with a Postgres mailbox and S3. The wire contract is `../docs/bb-contract.md`; the domain is `docs/domain.md` (read it before changing `src/domain`).

## Definition of done
`bun run verify` passes: typecheck (with Effect language-service diagnostics), oxlint (layer boundaries), knip, tests. Never weaken a check to get green.

## Layers (lint-enforced)
`src/domain` (pure, `effect` only) ← `src/ports` (Effect services) ← `src/app` (use cases, HTTP) ← `src/adapters/*` ← `src/worker` / `src/dev` (composition roots). Use cases never import adapters. Every external system is a port with a fake first; real adapters pass the same tests.

## Effect
Effect v4 (`effect@4.1.4`). v3 APIs are wrong here. See `/home/user/campaign-manager/.claude/skills/effect-v4` conventions: `Context.Service`, `Result` in pure code, tagged errors with `reason`, no ambient clock (use `Clock`).

## Tests
Every invariant in `docs/domain.md` has a property test that names it. When adding a test for a rule, break the rule briefly and see it go red.

## Running on celld
`celld dev . --port 18787` (needs `esbuild` on PATH: `node_modules/.bin`). `wrangler.jsonc` sets test mode (`BB_TEST_ADMIN=1`), which exposes mock-bb's `/admin/*` endpoints and fault switches so `../scripts/contract-test.sh`-style Go tests and the compose drills run unchanged against real bb. The Go contract test: `BB_CONTRACT_URL=http://127.0.0.1:18787 BB_CONTRACT_TOKEN=local-bb-token go test ./pkg/agent -run BBContract` from `upstream/server` with the overlay applied.
