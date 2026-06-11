# Assumptions record — ask-the-code

Per-agent assumptions for ask-the-code (abbreviated "ATC" below), complementing the
core/cross-cutting set in `docs/assumptions.md`.

## Identifier alignment (A-X-1 applied)

- **A-ATC-1 — Renamed `atc` → `ask-the-code` everywhere the agent identifier appears.** Nothing is
  deployed (owner-confirmed zero deploys), so the rename is safe. Covered: descriptor `identifier`,
  queue refs (`ask-the-code-requests` / `ask-the-code-requests-dlq`), the infra registry entry
  (id, `leanish/agent-ask-the-code` ECR repo, `ASK_THE_CODE_IMAGE_TAG` per A-X-6), lifecycle events
  (`source: "ask-the-code"`, detail-types `ask-the-code.ask.*` — the detail-type pattern is
  `<identifier>.<kind>.<event>`), the catalog consumer-scoping key
  (`forConsumer("ask-the-code")` / `extensions["ask-the-code"]`), the SSM signing-key path segment
  (`/leanish/agents/ask-the-code/signing-keys/*` — derived from the identifier by `agent-infra`),
  the `WORKSPACE_ROOT` default (`/tmp/ask-the-code-workspaces`), the attachment scratch-dir prefix,
  the production env vars `ASK_THE_CODE_SIGNING_KEY_TTL_MS` / `ASK_THE_CODE_TMP_DIR`, and the
  Docker image label `leanish.agent=ask-the-code`.
- **A-ATC-2 — Consumers are unaffected.** The signed envelope's `kind` / `consumer` / signature
  fields don't carry the agent identifier, so no consumer-facing wire shape changes. The one
  consumer-visible convention that does embed the identifier — the terminal-reply queue naming
  (`*-ask-the-code-replies`) and the lifecycle detail-types — has no deployed consumers yet.

## Deliberate keeps

- **A-ATC-3 — `envelope.kind: "ask"` stays.** It is the agent's domain vocabulary (see AGENTS.md),
  not the agent identifier.
- **A-ATC-4 — Dev-only tooling keeps the short prefix.** The `atc-dev-publish` bin, its
  `ATC_DEV_CONSUMER_SECRET` env var, and the local rehearsal image/container names
  (`atc-lambda:rehearsal` / `atc-lambda-rehearsal`) are local-dev conveniences that never reach
  AWS; renaming them is churn without consistency value.
- **A-ATC-5 — "ATC" stays as a prose abbreviation** (README/AGENTS.md introduce it), and TypeScript
  symbol names keep the `Atc`/`ATC_` prefix (`AtcPayload`, `atcLambdaHandler`, `ATC_LIMITS`, …):
  TS identifiers can't contain dashes, so the prefix is the code-level form of the same
  abbreviation. All string/config identifiers use `ask-the-code`.
- **A-ATC-6 — `atc-ui` sample consumer id stays in tests/fixtures.** Consumer ids name the
  consumer, not the agent; it reads as "the ATC UI client" and exercising the rename through it
  would blur that boundary.

## Related infra decisions

- **A-ATC-7 — Suite bus default renamed `atc-events` → `agent-events`.** The shared stack's
  EventBridge bus is suite-wide (every agent publishes lifecycle events to it), so it takes a
  fleet-neutral name rather than inheriting this agent's old identifier.
- **A-ATC-8 — Reply-queue IAM scoping parameterized.** `needs-policy.ts` scoped `sqs:SendMessage`
  to the literal `*-atc-replies`; it now scopes to `*-<agentId>-replies` from the descriptor
  identifier so the convention holds for every agent.
