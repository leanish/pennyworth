# `@leanish/runtime`

The shared runtime library every Layer-3 agent in the leanish suite depends on. Queue consumer + skill execution + working-copy sync + catalog access + idempotency.

**Specs**: the design contract is maintained separately (single source of truth).

**Siblings in this monorepo** (each its own deployable per suite-0004): the agents under
[`../../agents/`](../../agents) (ask-the-code, secure-it, document-it, triage-it, ship-it + its
webhook normalizer) all build on this runtime; [`../catalog-it`](../catalog-it/README.md) is the
catalog read-side library the runtime consumes; [`../../infra`](../../infra/README.md) provisions
any agent built on the runtime.

## Phase

**Phase-1 complete; phase-2 self-publish shipped.** Implemented today:

- Full type contract (`RuntimeMessage`, `Runtime`, `AgentDescriptor`, `WorkingCopy`, `SyncResult`, every error class).
- Descriptor parser with phase-1/2/3 trigger filtering + skill compatibility validation.
- Stage-gated dispatcher with async-local correlation propagation.
- Bundled skills (`karpathy-guidelines`, `diagnose`) under `skills/`.
- Skill staging (canonical `--plugin-dir` layout + `.claude-plugin/plugin.json` manifest).
- Real `ClaudeCodeRunner` + `CodexRunner` subprocesses + `FakeCodingAgentRunner` for tests (strict by default — unregistered entrypoints throw; response synthesis from the entrypoint's `outputSchema` is opt-in via `run-local --fake-runner` for smoke-test ergonomics).
- `run-local` CLI shipped as the `agent-runtime` bin (source: `src/bin/agent-runtime.ts`; emitted at `dist/bin/agent-runtime.js`; `package.json#bin` points there). The CLI prints the handler's return value as JSON on stdout, or `null` if the handler returns undefined (no `{status:"ok"}` wrapper — see ADR-0004 / the local CLI contract).
- Sub-entrypoints: `@leanish/runtime/local` (local-mode adapters bundle), `@leanish/runtime/lambda` (the operator-facing AWS Lambda cold-start surface), and `@leanish/runtime/testing` (in-memory fakes for downstream agent tests).
- Needs registry + auto-wired typed clients (eventbridge / sqs / s3 / github / jira), with `MissingNeedError` enforcement via `Proxy`.
- Secret redaction across log lines + captured fields.
- Envelope verification: recursive canonical-JSON HMAC-SHA256 + clock-skew window + `allowedKinds` allowlist.
- AWS-mode adapters: `DynamoIdempotencyStore` (ADR-0006 three-state claim with `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`), `DynamoConsumerRegistry`, `S3Catalog` (re-exported from `@leanish/catalog-it`).
- SQS Lambda entry shim — verify → claim → dispatch → complete/expire → `batchItemFailures` (plus a sibling `results: SqsRecordOutcome[]` for observability). The shim accepts two wire shapes per record: consumer envelopes and serialised runtime messages (`sourceTrigger: "self" | "scheduler"`, ADR-0011/ADR-0012), with a forgery guard for agents that mix signed-envelope consumers with unsigned runtime-message traffic.
- Phase-2 self-publish (ADR-0011): `runtime.publish` (SQS SendMessage to the agent's own input queue) and `runtime.publishDelayed` (one-shot EventBridge Scheduler schedule, canonical-JSON-derived name for dedupe). Wired via `BuildRuntimeOptions.selfPublisher` — `createAwsSelfPublisher` in AWS mode, `createLocalSelfPublisher` for local/tests; a runtime built without one throws `SelfPublishNotConfiguredError` on first use.
- LocalStack-backed integration harness (`LocalStackHarness` in `@leanish/runtime/testing`) + `test-integration/` suite covering the Dynamo idempotency store, S3 catalog, and the self-publish path.

## Scripts

```bash
npm install
npm run typecheck   # tsc -b --noEmit + tsc -p tsconfig.test.json --noEmit
npm run build       # tsc -b + chmod +x dist/bin/agent-runtime.js
npm test            # vitest run
npm run test:watch  # vitest
npm run check       # typecheck + build + test — the fast acceptance gate
npm run test:integration  # LocalStack-backed suite (needs `docker compose up -d localstack`)
npm run check:full  # check + test:integration
```

## Public API

```ts
import { defineAgent } from "@leanish/runtime";

export default defineAgent({
  identifier: "ask-the-code",
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
  aws-mode/           # SQS Lambda entry shim + runtime-message body parsing + shared client config
  self-publish/       # ADR-0011 publish/publishDelayed adapters (AWS + local) + canonical serialisation
  runtime/            # buildRuntime + runLocal + run-local CLI
  index.ts            # public exports

test/
  unit/               # one file per src module
  e2e/                # end-to-end local-mode dispatch

test-integration/     # LocalStack-backed suite (npm run test:integration)
```
