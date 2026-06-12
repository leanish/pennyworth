# `@leanish/document-it`

Scheduled docs-drift audit agent. A cron tick fans out one audit per opted-in project
(`extensions["document-it"].enabled === true`, strictly); each audit syncs the project's working
copy and runs the `verify-docs` skill, which checks the in-repo docs (README, `docs/`, behavioral
code comments) against the actual code, classifies drift (**stale / wrong / missing**, with
confidence), and batches corrections into **one draft PR** per project on the stable
`document-it/docs-drift` branch. Published-page drift comes back as **suggestions in the skill
output only** — nothing is ever posted or merged by the agent. Built on `@leanish/runtime`.

```
scheduler cron tick (stage=init)
  → list opted-in projects → runtime.publish one breakdown message per project
stage=breakdown (sourceTrigger=self)
  → syncWorkingCopies → runSkill("verify-docs") → structured audit-summary log
```

Accuracy only: it corrects what is stale, wrong, or missing — it does not restyle or reformat prose
that is already accurate.

## Status

Handler, skill, and Lambda entry implemented. The infra package provisions the deploy wiring
(input queue + DLQ, recurring `rate(1 day)` scheduler tick, per-agent schedule group + delivery
role, and the `SELF_QUEUE_URL` / `SELF_QUEUE_ARN` / `SCHEDULE_GROUP_NAME` / `SCHEDULER_ROLE_ARN`
Lambda env contract). The Dockerfile / container-image pipeline is still deferred — see
`ASSUMPTIONS.md` for the remaining provisional decisions, including the invented `docSet` shape
and the deferred published-suggestion delivery channel.

## Layout

```
agent.yaml                    # descriptor (scheduler trigger — phase-2 parser required)
skills/verify-docs/SKILL.md   # entry-point skill: audit, classify, draft PR, suggest
src/
  payload.ts                  # per-stage payload types (init, breakdown)
  handler.ts                  # stage dispatch + strict opt-in filter + skill IO types
  agent.ts                    # defineAgent entry point
  lambda.ts                   # AWS Lambda entry (env vars documented in-file)
  index.ts                    # public re-exports
test/                         # vitest specs (hermetic — fakes from @leanish/runtime/testing)
test-integration/             # LocalStack-backed end-to-end specs (real SQS/DDB/S3/Scheduler)
```

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test                  # vitest run (hermetic unit specs)
npm run check             # typecheck + build + test
npm run test:integration  # LocalStack-backed end-to-end specs (docker compose up -d localstack)
npm run check:full        # check + test:integration
```
