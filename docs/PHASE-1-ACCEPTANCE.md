# Phase-1 acceptance

The architectural invariants this implementation must honour live in the **private specs repo** (canonical, suite-wide). This file lists the **implementation-side** acceptance checks for the phase-1 release candidate in this monorepo.

Phase-1 ships three implementation packages plus a phase-2 placeholder:

- `catalogit` — read-only catalog library + CLI (subcommands: `validate`, `bundle`, `publish`).
- `agent-runtime` — shared runtime library + `run-local` CLI. Sub-entrypoints: `./local`, `./lambda`, `./testing`.
- `agent-atc` — ATC backend (only phase-1 Layer-3 agent) + `atc-dev-publish` smoke-test bin.
- `agent-secureit` — phase-2 placeholder; types-only, not on phase-1 acceptance.

Dependency graph (`file:` deps):

```
agent-atc      ──► agent-runtime ──► catalogit
agent-secureit ──► agent-runtime ──► catalogit   (phase-2 placeholder)
```

## Per-package gates

Every phase-1 package exposes:

- `npm run check` — Docker-free fast acceptance gate (`typecheck && build && test`).
- `npm run check:full` — full acceptance gate (`check && test:integration`; LocalStack must be running for the integration suite).

Boot LocalStack from this directory: `docker compose up -d localstack`.

## Implementation discipline

- **Source files are TypeScript only.** Checked-in JavaScript appears exclusively as generated output under `dist/`. Bin shebangs are TS source under `src/bin/*.ts`; `package.json#bin` points at the compiled `./dist/bin/<name>.js`.
- **Strict-TS baseline** per `../specs/agentic-development/agent-runtime/docs/adr/0009-runtime-tech-stack.md` — `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`. Enforced by `tsc --noEmit` in CI.
- **`AgentDefinition.handle(...)` returns `Promise<R>`** with `R` defaulting to `unknown`. AWS mode discards; local mode propagates via `run-local`'s resolved value. ATC declares `R = AtcTerminalReply`.
- **`run-local --fake-runner` smoke pipeline**: `atc-dev-publish | run-local --fake-runner` must succeed end-to-end and resolve to the terminal reply directly on stdout with no per-entrypoint test-author setup.
- **LocalStack-backed integration tests** ship in phase 1 alongside unit tests. Each package exposes `npm run test:integration` and `npm run check:full`. The fast gate (`npm run check`) is Docker-free by path separation: unit tests live under `test/`, integration tests under `test-integration/`. The integration suite **fails loudly with an actionable error** if LocalStack isn't reachable — `LocalStackHarness.start()` (or catalogit's `requireLocalStack` helper) throws "LocalStack not reachable at `<endpoint>`; run `docker compose up -d localstack`". The acceptance gate never silently downgrades to skipped.

## Lambda-container rehearsal

`agents/ask-the-code/scripts/lambda-rehearsal.ts` exercises the full Node-on-Lambda path locally: builds the per-agent image atop the shared `leanish/agent-runtime-base`, wires it to LocalStack via the AWS Runtime Interface Emulator, fires one signed envelope, asserts handler + reply + idempotency wiring. Prerequisites:

- `docker compose up -d localstack` (LocalStack running)
- RIE binary at `~/.aws-lambda-rie/aws-lambda-rie` (one-time download from the `aws/aws-lambda-runtime-interface-emulator` GitHub releases)
- `npm run lambda:build` to build the image first
- Then: `npm run lambda:rehearsal`

## Suite reference

Architectural invariants (idempotency contract, envelope HMAC canonicalisation, envelope-verification reason taxonomy, coding-agent subprocess shape, skill staging fidelity, working-copy sync outcomes, secret redaction, logger correlation, etc.) live in `../specs/`. This file does NOT re-derive them.
