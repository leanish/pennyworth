# `@leanish/ask-the-code`

ATC backend — Layer-3 agent for codebase Q&A. Built on `@leanish/runtime`.

**Specs**: design contract — `overview.md`, `architecture.md`, `queue-api.md`, `state-schema.md` — maintained separately.

**Sibling repos** (suite-0004 — one agent / library / one repo / one deployable):

- `../../core/runtime/` — the substrate this depends on.
- `../secure-it/` — a fellow Layer-3 agent (phase-2).

## Status

**Phase-1 implemented.** The handler in `src/handler.ts` runs the canonical six-step transformation:

1. Validate consumer-request shape + enforce the limits (`question` ≤ 8 KB, transcript ≤ 128 KB serialised, ≤ 200 unique attachments, ≤ 100 MB per attachment, ≤ 200 MB total).
2. Resolve project scope from `projectIds` / `includeAll` / `runtime.routeProjects` fallback.
3. Materialise blob attachments to `/tmp` via `runtime.clients.s3.getObject`.
4. Resolve execution overrides via `runtime.execution.resolve(payload.execution)`.
5. Apply `noSync` / `scopeOnly` flags.
6. `runtime.runSkill({ entrypoint: "ask", input: ..., workingCopies, ...execution })`.

Plus the surrounding ATC-owned protocol:

- Ordered lifecycle events on EventBridge (`atc.ask.started` → `atc.ask.status` × stages → `atc.ask.completed` / `atc.ask.failed`).
- Terminal reply delivered to `envelope.replyTo` via SQS (`AtcTerminalSuccess` / `AtcTerminalFailure` shapes).
- Error-kind mapping (validation-error / config-error / agent-error / io-error) per queue-api.md.

The `ask` skill itself ships in this agent's own `skills/ask/SKILL.md` (per ADR-0001 + suite-0010).

## What's here vs. what's not here

**Here:**

- The dispatch handler (`src/handler.ts`) + per-stage payload types.
- The `atc-dev-publish` smoke-test CLI for local-mode pipelining.
- The AWS Lambda entry module (`src/lambda.ts`) — see `@leanish/ask-the-code/lambda`. Builds the runtime + AWS-mode adapters (Dynamo idempotency / Dynamo consumer registry / S3 catalog / `LocalGitWorkspace` rooted at `/tmp`) at cold start and exposes `atcLambdaHandler` for `agent-infra` to register with the Lambda runtime. Required env vars (provisioned by `agent-infra`): `IDEMPOTENCY_TABLE_NAME`, `CONSUMER_REGISTRY_TABLE_NAME`, `CATALOG_BUCKET`, optional `CATALOG_KEY` (`catalog.json`), `EVENT_BUS_NAME`, optional `WORKSPACE_ROOT` (`/tmp/atc-workspaces`).

**Not here:**

- Real `claude` subprocess execution against a checked-out catalog. The runtime supports it (`ClaudeCodeRunner`), but it needs a live `claude` CLI and project clones; covered by integration tests run separately.
- Phase-2 readback (`ask-by-id`, `history-query`) — deferred per the spec.
- `agent-infra` IaC for ATC's deployable (the CloudFormation / CDK templates that wire `atcLambdaHandler` to the input SQS queue + DynamoDB tables + EventBridge bus). That lives in `agent-infra` once it exists.

## Test scaffolding

ATC's tests depend on the runtime's testing sub-entrypoint:

- `@leanish/runtime/testing` — `InMemoryEventBus`, `InMemorySqsBus`,
  `MemoryIdempotencyStore`, `FakeCodingAgentRunner` (strict by default), and
  related in-memory fakes. Import from this subpath in test code only.
- `@leanish/runtime/local` — local-mode adapter bundle the CLI uses.
  ATC's handler tests don't need it; the test harness builds the runtime
  bag in-process.

Production builds must not import from either subpath.

## Scripts

```bash
npm install
npm run typecheck       # tsc -b --noEmit + tsc -p tsconfig.test.json --noEmit
npm run build           # tsc -b + chmod +x dist/bin/atc-dev-publish.js
npm test                # vitest run (local-mode unit tests)
npm run check           # typecheck + build + test — the phase-1 acceptance gate
```

## Layout

```
agent.yaml              # the descriptor (matches the architecture spec)
src/
  agent.ts              # defineAgent({...}) — the runtime entry point
  payload.ts            # AtcPayload, AtcEnvelope, AtcRequest types
  index.ts              # public re-exports
test/                   # vitest specs
```
