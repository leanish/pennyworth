# `@leanish/agent-secureit` *(phase-2 placeholder — NOT part of phase-1 acceptance)*

> ⚠️ **Out of scope for phase 1.** The phase-1 acceptance checklist
> (`../PHASE-1-ACCEPTANCE.md`) covers `catalogit`, `agent-runtime`, and
> `agent-atc` only. This package is shipped as a typed placeholder to
> lock the phase-2 descriptor + payload shapes. See `SCOPE.md` in this
> directory.

Phase-2 Layer-3 agent. Scheduled cron scan → per-project fan-out → opens draft PRs for security alerts → schedules a `revisit` to flip / adapt / rollback / defer based on CI state. Built on `@leanish/agent-runtime`.

**Specs**: `../../specs/agentic-development/agent-runtime/specs/skills/secureit.md` + `secureit-revisit.md`; `../../specs/agentic-development/docs/adr/suite-0011-test-verification-via-project-ci.md`; ADRs 0011 + 0012.

**Sibling packages** (under `agentic-development/`):

- `../../packages/agent-runtime/` — the substrate this depends on.
- `../agent-atc/` — the phase-1 Layer-3 agent (ATC Q&A backend).
- `../../packages/catalogit/` — read-side catalog library.

## Status

**Phase-2 placeholder — not part of phase-1 acceptance.** This package ships **types only** today (per-stage payload contracts in `src/payload.ts` plus the locked `agent.yaml` descriptor). There is no `defineAgent({...})` handler yet — the handler depends on `runtime.publish` / `runtime.publishDelayed`, which are deliberately absent from the phase-1 `Runtime` interface (ADR-0011).

Phase-2 implementation outline:

```ts
if (stage === "init")      → catalog.forConsumer("secureit").list() + runtime.publish(stage=breakdown)
if (stage === "breakdown") → syncWorkingCopies + runSkill("secureit") + runtime.publishDelayed(stage=revisit, after=1h)
if (stage === "revisit")   → syncWorkingCopies + runSkill("secureit-revisit") + optional reschedule
```

The two skills (`secureit`, `secureit-revisit`) live bundled inside `../../packages/agent-runtime/skills/` per ADR-0001.

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test           # vitest run (placeholder smoke tests only)
npm run check      # typecheck + build + test — phase-1 placeholder gate
```

## Test scaffolding

The placeholder ships **types only** and a single package-exports smoke
test that asserts the payload types compile and no default export exists
yet. When phase-2 implementation lands and a handler appears in
`src/agent.ts`, real handler tests will pull from:

- `@leanish/agent-runtime/testing` — `MemoryIdempotencyStore`,
  `FakeCodingAgentRunner` (strict default — opt into synthesised responses
  with `{ synthesiseDefault: true }`), `InMemoryEventBus`, `InMemorySqsBus`,
  and the in-memory catalog/workspace.

## Layout

```
agent.yaml              # descriptor (matches ../../specs/agentic-development/agent-runtime/specs/descriptor.md example)
src/
  payload.ts            # per-stage payload types
  index.ts              # public re-exports
test/                   # vitest specs
```

Phase 2 adds `src/agent.ts` with the real `defineAgent({...})` entry point.
