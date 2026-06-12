# `@leanish/ask-the-code`

ask-the-code (abbreviated "ATC" below) — Layer-3 agent for codebase Q&A. Built on `@leanish/runtime`.

**Specs**: design contract — `overview.md`, `architecture.md`, `queue-api.md`, `state-schema.md` — maintained separately.

**Sibling repos** (suite-0004 — one agent / library / one repo / one deployable):

- `../../core/runtime/` — the substrate this depends on.
- `../secure-it/` — a fellow Layer-3 agent (phase-2).

## Status

**Phase-1 implemented.** The handler in `src/handler.ts` runs the canonical six-step transformation:

1. Validate consumer-request shape + enforce the limits (`question` ≤ 8 KB, transcript ≤ 128 KB serialised, ≤ 200 unique attachments, ≤ 100 MB per attachment, ≤ 200 MB total).
2. Resolve execution overrides via `runtime.execution.resolve(request.execution)` — before any per-stage status events, so a malformed override fails between `started` and `failed` with no half-emitted protocol.
3. Resolve project scope from `projectIds` / `includeAll` / `runtime.routeProjects` fallback (`scopeOnly: true` short-circuits here with a complete-shape diagnostic reply; sync + skill stages emit as `skipped`).
4. Materialise blob attachments to a temp dir via `runtime.clients.s3.getObject` (deduped by `blobUri`; cleaned up after the run).
5. Sync working copies via `runtime.syncWorkingCopies` (or skip via `noSync` / no resolved projects).
6. `runtime.runSkill({ entrypoint: "ask", input: ..., workingCopies, ...execution })`.

Plus the surrounding ATC-owned protocol:

- Ordered lifecycle events on EventBridge (`ask-the-code.ask.started` → `ask-the-code.ask.status` × stages → `ask-the-code.ask.completed` / `ask-the-code.ask.failed`).
- Terminal reply delivered to `envelope.replyTo` via SQS (`AtcTerminalSuccess` / `AtcTerminalFailure` shapes).
- Error-kind mapping (validation-error / config-error / agent-error / io-error) per queue-api.md.

The `ask` skill itself ships in this agent's own `skills/ask/SKILL.md` (per ADR-0001 + suite-0010).

## What's here vs. what's not here

**Here:**

- The dispatch handler (`src/handler.ts`) + per-stage payload types.
- The `atc-dev-publish` smoke-test CLI for local-mode pipelining.
- The AWS Lambda entry module (`src/lambda.ts`) — see `@leanish/ask-the-code/lambda`. Builds the runtime + AWS-mode adapters (Dynamo idempotency / Dynamo consumer registry / S3 catalog / `LocalGitWorkspace` rooted at `/tmp`) at cold start and exposes `atcLambdaHandler` for `agent-infra` to register with the Lambda runtime. Required env vars (provisioned by `agent-infra`): `IDEMPOTENCY_TABLE_NAME`, `CONSUMER_REGISTRY_TABLE_NAME`, `CATALOG_BUCKET`, optional `CATALOG_KEY` (`catalog.json`), `EVENT_BUS_NAME`, optional `WORKSPACE_ROOT` (`/tmp/ask-the-code-workspaces`).

**Not here:**

- Real `claude` subprocess execution against a checked-out catalog. The runtime supports it (`ClaudeCodeRunner`) and `agent-runtime run-local` exercises it manually; the committed integration tests (`test-integration/`, run via `npm run test:integration`) wire `FakeCodingAgentRunner` so the gate needs no live CLI.
- Phase-2 readback (`ask-by-id`, `history-query`) — deferred per the spec.
- IaC for ATC's deployable. That lives in the monorepo's `../../infra/` (agent-infra), where ATC is registered as id `ask-the-code`; this package carries zero IaC (suite-0006).

## Test scaffolding

ATC's tests depend on the runtime's testing sub-entrypoint:

- `@leanish/runtime/testing` — `InMemoryEventBus`, `InMemorySqsBus`,
  `MemoryIdempotencyStore`, `FakeCodingAgentRunner` (strict by default),
  `LocalStackHarness` (unique-per-run AWS resources for `test-integration/`),
  and related fakes. Import from this subpath in test code only.
- `@leanish/runtime/local` — local-mode adapter bundle the CLI uses.
  ATC's handler tests don't need it; the test harness builds the runtime
  bag in-process.

Production builds must not import from either subpath.

## Scripts

```bash
npm install
npm run typecheck         # tsc -b --noEmit + tsc -p tsconfig.test.json --noEmit
npm run build             # tsc -b + chmod +x dist/bin/atc-dev-publish.js
npm test                  # vitest run (local-mode unit tests)
npm run check             # typecheck + build + test — the phase-1 acceptance gate
npm run test:integration  # LocalStack-backed specs in test-integration/ (needs LocalStack up)
npm run check:full        # check + test:integration
npm run smoke:local       # atc-dev-publish | agent-runtime run-local --fake-runner pipeline
npm run lambda:build      # shared base image + this agent's Lambda container image
npm run lambda:rehearsal  # boot the image via RIE against LocalStack, fire one scopeOnly ask
```

## Layout

```
agent.yaml                # the descriptor (matches the architecture spec)
skills/ask/SKILL.md       # the ask entry-point skill (ADR-0001 — ships with the agent)
src/
  agent.ts                # defineAgent({...}) — the runtime entry point
  handler.ts              # the six-step transformation + lifecycle protocol
  payload.ts              # AtcPayload + AtcEnvelope types
  request-schema.ts       # AtcRequest types + parseAtcRequest boundary validator
  project-scope.ts        # projectIds / includeAll / router scope resolution
  attachments.ts          # blobUri → local-disk materialisation + cleanup
  lifecycle-events.ts     # LifecycleEmitter — the ordered EventBridge protocol
  terminal-reply.ts       # terminal-reply shapes + SQS delivery to replyTo
  signing-key-resolver.ts # literal / ssm-parameter signing-key resolution
  lambda.ts               # AWS Lambda entry module (atcLambdaHandler)
  dev-publish.ts          # atc-dev-publish CLI (bin shim in src/bin/)
  index.ts                # public re-exports
test/                     # vitest unit specs
test-integration/         # LocalStack-backed integration specs
```
