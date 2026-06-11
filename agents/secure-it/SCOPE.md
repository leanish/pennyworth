# SCOPE — agent-secure-it

## In scope (implemented)

- `agent.yaml` — scheduler trigger, `stages: [init, breakdown, revisit]`,
  entrypoints `secure-it` + `secure-it-revisit`, `needs: [github]`.
  Parses under the runtime's **phase-2** descriptor parser.
- Per-stage handler (`src/handler.ts`):
  - `init` — catalog fan-out, strict explicit opt-in
    (`extensions["secure-it"].enabled === true`), one `breakdown`
    self-publish per eligible project;
  - `breakdown` — opt-in re-check, working-copy sync, `secure-it` skill
    run, one delayed `revisit` (1h) per PR the skill opened/updated;
  - `revisit` — `secure-it-revisit` skill run (no working copy),
    reschedule with bumped `revisitCount` when requested, hard cap of 2.
- The two entry-point skills (`skills/*/SKILL.md`): draft-PR-per-alert
  scan and the flip / adapt / rollback / defer follow-up. All GitHub work
  via `gh` + inherited `GITHUB_TOKEN`.
- AWS Lambda entry (`src/lambda.ts`): phase-2 descriptor load, S3
  catalog, Dynamo idempotency, AWS self-publisher (SQS + EventBridge
  Scheduler one-shots), SQS shim without a consumer registry.
- Deploy registration in `infra/src/registry.ts`.
- Hermetic vitest coverage of all of the above.

## Deferred

- **Cron tick provisioning** — the recurring EventBridge Scheduler rule
  that drops the `init` message onto the input queue.
- **Scheduler IAM + schedule group** — the per-agent group and the role
  the Scheduler assumes to SendMessage one-shot revisit messages, plus
  wiring the `SELF_QUEUE_URL` / `SELF_QUEUE_ARN` / `SCHEDULE_GROUP_NAME` /
  `SCHEDULER_ROLE_ARN` env vars into the agent stack.
- **Dockerfile / image build** for the Lambda container.
- **Webhook-driven revisit** — a CI-completion push source for the same
  `revisit` stage (faster than the 1h timer; the scheduled message stays
  as the fallback).
- **Execution overrides** — `payload.execution` is typed but not applied
  to `runSkill`; wire it when a caller exists.
- **Auto-merge opt-in** — flipping stops at ready-for-review; a per-project
  trust flag for merging green PRs is a possible later step.

See `ASSUMPTIONS.md` for the reasoning behind the settled behaviors.
