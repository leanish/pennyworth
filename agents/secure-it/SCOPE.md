# SCOPE — phase-2 placeholder (types only)

`@leanish/agent-secureit` is a **phase-2 placeholder** and is NOT part of phase-1 acceptance.

What's here today:

- `agent.yaml` — the descriptor in the locked phase-2 shape (`type: scheduler` trigger; `stages: [init, breakdown, revisit]`; entrypoints `secureit` + `secureit-revisit`; `needs: [github]`).
- `src/payload.ts` — the per-stage payload types (`SecureitInitPayload`, `SecureitBreakdownPayload`, `SecureitRevisitPayload`).
- `src/index.ts` — re-exports the payload types. **No default export, no handler.**
- One smoke test that confirms the type exports exist and there is no runtime default export yet.

The package builds, typechecks, and tests pass — but it ships **no executable handler**. That is deliberate: the handler depends on `runtime.publish` / `runtime.publishDelayed`, which are deliberately absent from the phase-1 `Runtime` interface (ADR-0011). Phase 2 adds `src/agent.ts` and re-exports its `default` from `src/index.ts`.

## Why keep it at all

1. Locks the **descriptor + payload contract** for phase-2 so the rest of the suite can reference `@leanish/agent-secureit`'s types (spec cross-refs, test fixtures, agent-infra IaC scaffolding) without inventing a moving target.
2. The suite layout makes the phase-2 next step obvious from `agentic-development/` alone.

The earlier scaffold shipped a typed handler that threw on every invocation, with a test asserting it threw. That was worse than not shipping at all — it gave the false impression of working code. Removed.

## Phase-1 acceptance

Defined in `../PHASE-1-ACCEPTANCE.md`. The checklist scope is `catalogit` + `agent-runtime` + `agent-atc`. This package is **not** on it.

## When phase 2 starts

The blockers are spec'd:

- `runtime.publish` real implementation (currently absent from the phase-1 `Runtime` interface).
- `runtime.publishDelayed` real implementation (same).
- `type: scheduler` trigger support in the descriptor parser + Lambda shim.
- The `secureit` + `secureit-revisit` skills bundled in `@leanish/agent-runtime/skills/`.

When those land:

1. Add `src/agent.ts` with the real `defineAgent({...})`.
2. Re-export the default from `src/index.ts`.
3. Replace the package-exports test with handler tests.
4. Update this SCOPE.md to describe the live behavior, or delete it.

## Eligibility rule for the future handler

Secureit is **write-capable**: the handler opens pull requests, posts comments, may apply labels. Catalog membership is therefore **necessary but not sufficient** for eligibility. The phase-2 handler must apply an explicit opt-in check on top of `runtime.catalog.forConsumer("secureit").list()`:

- A project is eligible only when `extensions.secureit?.enabled === true` — the value is explicitly the boolean `true`, not absence or any falsy default.
- A skeleton project record (no `extensions.secureit` block at all) is **not** eligible, even though it is included in `forConsumer("secureit").list()` per the catalog's default-on convention.

This pattern generalises: any future side-effecting agent in the suite should layer an explicit-opt-in check on top of the catalog's default-on convention. The convention is a baseline; safety policy for write-capable agents lives in the agent that has the safety concern, not in the catalog.

## See also

- `../../specs/agentic-development/agent-runtime/specs/skills/secureit.md` — phase-2 skill spec.
- `../../specs/agentic-development/agent-runtime/specs/skills/secureit-revisit.md` — phase-2 skill spec.
- `../../specs/agentic-development/docs/adr/suite-0011-test-verification-via-project-ci.md` — why secureit uses GH Actions for verification.
- `../../specs/agentic-development/agent-runtime/docs/adr/0011-delayed-self-publish.md` — `publishDelayed` design.
