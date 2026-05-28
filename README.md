# `@leanish/agent-runtime`

The shared runtime library every Layer-3 agent in the leanish suite depends on. Queue consumer + skill execution + working-copy sync + catalog access + idempotency.

**Specs**: `../../specs/agentic-development/agent-runtime/` (single source of truth for the contract).

**Sibling projects under `agentic-development/`** (each its own deployable per suite-0004):

- `../agent-atc/` — ATC Q&A backend (uses `@leanish/agent-runtime`); package `@leanish/agent-atc`.
- `../agent-secureit/` — phase-2 dep-upgrade agent (uses `@leanish/agent-runtime`).

Other suite siblings not yet implemented here:

- `catalogit` — catalog read-side library (consumed by the runtime).
- `agent-infra` — IaC for any agent built on the runtime.

## Phase

**Phase-1 complete.** Implemented today:

- Full type contract (`RuntimeMessage`, `Runtime`, `AgentDescriptor`, `WorkingCopy`, `SyncResult`, every error class).
- Descriptor parser with phase-1/2/3 trigger filtering + skill compatibility validation.
- Stage-gated dispatcher with async-local correlation propagation.
- Bundled skills (`ask`, `karpathy-guidelines`, `diagnose`) under `skills/`.
- Skill staging (canonical `--plugin-dir` layout + `.claude-plugin/plugin.json` manifest).
- Real `ClaudeCodeRunner` + `CodexRunner` subprocesses + `FakeCodingAgentRunner` for tests (strict by default — unregistered entrypoints throw; response synthesis from the entrypoint's `outputSchema` is opt-in via `run-local --fake-runner` for smoke-test ergonomics).
- `run-local` CLI shipped as the `agent-runtime` bin (source: `src/bin/agent-runtime.ts`; emitted at `dist/bin/agent-runtime.js`; `package.json#bin` points there). The CLI prints the handler's return value as JSON on stdout, or `null` if the handler returns undefined (no `{status:"ok"}` wrapper — see ADR-0004 / the local CLI contract).
- Sub-entrypoints: `@leanish/agent-runtime/local` (local-mode adapters bundle) and `@leanish/agent-runtime/testing` (in-memory fakes for downstream agent tests).
- Needs registry + auto-wired typed clients (eventbridge / sqs / s3 / github), with `MissingNeedError` enforcement via `Proxy`.
- Secret redaction across log lines + captured fields.
- Envelope verification: recursive canonical-JSON HMAC-SHA256 + clock-skew window + `allowedKinds` allowlist.
- AWS-mode adapters: `DynamoIdempotencyStore` (ADR-0006 three-state claim with `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`), `DynamoConsumerRegistry`, `S3Catalog` (re-exported from `@leanish/catalogit`).
- SQS Lambda entry shim — verify → claim → dispatch → complete/expire → `batchItemFailures` (plus a sibling `results: SqsRecordOutcome[]` for observability).

**Deliberately absent in phase 1**: `runtime.publish` + `runtime.publishDelayed`. The `Runtime` interface does not expose them, so downstream agents reaching for them in phase 1 get a compile-time error rather than a runtime throw. The `PublishArgs` / `PublishDelayedArgs` payload types remain exported from the public surface as the phase-2 contract anchor (used by `ADR-0011` + `agent-secureit` design docs). Phase-2 widens `Runtime` to include the helpers.

## Scripts

```bash
npm install
npm run typecheck   # tsc -b --noEmit + tsc -p tsconfig.test.json --noEmit
npm run build       # tsc -b + chmod +x dist/bin/agent-runtime.js
npm test            # vitest run
npm run test:watch  # vitest
npm run check       # typecheck + build + test — the phase-1 acceptance gate
```

## Public API

```ts
import { defineAgent } from "@leanish/agent-runtime";

export default defineAgent({
  identifier: "atc",
  async handle(message, runtime) {
    // message: RuntimeMessage<P>
    // runtime: { catalog, syncWorkingCopies, runSkill, execution, clients, logger, ... }
  },
});
```

The `runtime` object's full surface is `src/types/runtime.ts`. Errors are in `src/errors.ts`.

## Layout

```
src/
  types/              # RuntimeMessage, Stage, SourceTrigger, Project, WorkingCopy, Runtime, etc.
  errors.ts           # UnhandledStageError, EntrypointInvocationError, ... (canonical reasons)
  descriptor/         # agent.yaml loader + validator
  dispatch/           # canonical pre-handler checks
  define-agent.ts
  idempotency/        # IdempotencyStore (AWS-mode; local exempt per ADR-0006)
  consumer-registry/  # ConsumerRegistry (signedEnvelope verifier backing)
  working-copy/       # LocalGitWorkspace + InMemoryWorkspace
  execution/          # runtime.execution.resolve helper
  logger/             # ConsoleLogger
  skill/              # SchemaValidator, SkillLoader, renderInput, extractTerminalJson, runSkill, FakeCodingAgentRunner
  runtime/            # buildRuntime + runLocal
  index.ts            # public exports

test/
  unit/               # one file per src module
  e2e/                # end-to-end local-mode dispatch
```
