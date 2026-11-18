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
