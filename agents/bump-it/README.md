# `@leanish/bump-it`

Scheduler-driven, **write-capable** Layer-3 agent. On a recurring tick it
fans out one worker per explicitly opted-in project; each worker runs a
full dependency-freshness + CVE pass and opens (or updates) **one batched
draft PR per project** (branch `bump-it/dependency-refresh`), then
schedules a delayed **revisit** that flips the PR to ready-for-review
when CI is green — or adapts, rolls back, or defers when it isn't. Built
on `@leanish/runtime`.

It **never merges**, **never force-pushes**, and only touches projects
with the explicit opt-in flag (see below).

**Sibling packages** (under the monorepo root):

- `../../core/runtime/` — the substrate this depends on.
- `../../core/catalog-it/` — read-side catalog library.
- `../ask-the-code/` — the consumer-triggered Q&A agent (ATC).

## Flow

```
scheduler tick (stage=init)
  → list catalog candidates via forConsumer("bump-it")
  → keep only extensions["bump-it"].enabled === true   (strict opt-in)
  → runtime.publish one breakdown message per project

breakdown (stage=breakdown, self)
  → re-resolve project + re-check opt-in (idempotent skip)
  → syncWorkingCopies([project])
  → runSkill("bump-it")     # freshness + CVE pass → one batched draft PR via gh
  → publishDelayed(revisit, afterSeconds=3600, revisitCount=0) per PR

revisit (stage=revisit, self)
  → runSkill("bump-it-revisit", workingCopies=[])   # reads PR + CI via gh
  → flipped / already-flipped → done
  → adapted / deferred + scheduleRevisit → publishDelayed with bumped count
  → cap (2 revisits per PR) enforced by the handler — the loop terminates
```

All GitHub work happens **inside the skills** via `gh` with the inherited
`GITHUB_TOKEN` (the `github` need); the handler only orchestrates catalog
reads, working-copy sync, skill runs, and self-publishing.

## Eligibility — explicit opt-in

bump-it is write-capable, so catalog membership is **not** enough. A
project is eligible only when its catalog record carries the literal

```yaml
extensions:
  bump-it:
    enabled: true
```

Absence, `false`, or any non-boolean value all exclude the project. The
check runs at the init fan-out **and again** at breakdown, so a curation
change between the two is honored.

## Layout

```
agent.yaml                      # descriptor: scheduler trigger, 3 stages, 2 entrypoints
src/
  payload.ts                    # per-stage payload types
  handler.ts                    # per-stage orchestration + skill I/O contracts
  agent.ts                      # defineAgent entry point (default export)
  lambda.ts                     # AWS Lambda entry (env contract in the module docstring)
  index.ts                      # public re-exports
skills/
  bump-it/SKILL.md            # breakdown-stage skill: freshness + CVE pass → batched draft PR
  bump-it-revisit/SKILL.md    # revisit-stage skill: flip / adapt / rollback / defer
test/                           # vitest specs (hermetic; fake runner + in-memory adapters)
test-integration/               # LocalStack-backed end-to-end specs (real S3/SQS/DDB/Scheduler)
```

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test
npm run check             # typecheck + build + test
npm run test:integration  # LocalStack-backed (docker compose up -d localstack)
npm run check:full        # check + test:integration
```

## Tests

Handler tests build a real runtime via `buildRuntime` with the shipped
`agent.yaml` + `skills/` (so skill input/output pass the **real**
schemas) and swap in test adapters from `@leanish/runtime/testing`:
`FakeCodingAgentRunner`, `InMemoryCatalog`, `InMemoryWorkspace`, and
`createLocalSelfPublisher` (captures `publish` / `publishDelayed` calls,
including `afterSeconds`).

The integration suite (`test-integration/`) drives the real Lambda entry
(`createBumpItLambdaHandler`) against LocalStack: the catalog is read
from real S3, init fan-out lands on a real SQS queue, idempotency claims
hit real DynamoDB, working copies come from a real `git clone`, and
revisits round-trip real EventBridge Scheduler one-shots. Only the
coding agent is faked (`FakeCodingAgentRunner` — no live CLI, no GitHub
writes). LocalStack Community's Scheduler is CRUD-only, so the delayed
leg simulates the fire by delivering the schedule's `Target.Input` to
the queue — byte-for-byte what the real SQS target does (see the
runtime's `test-integration/self-publish.test.ts` for the rationale).

## See also

- `ASSUMPTIONS.md` — decisions taken during implementation (per-alert
  PRs, delays/cap, deferred deploy wiring, …).
- `SCOPE.md` — what's in scope now and what's deliberately deferred.
