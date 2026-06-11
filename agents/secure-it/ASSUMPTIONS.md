# ASSUMPTIONS — agent-secure-it

Decisions taken while implementing the agent, recorded so reviewers and
future contributors don't have to reverse-engineer them from the code.

## 1. One batched dependency-refresh PR per project (owner-settled)

Originally implemented as one draft PR per security alert (per the early skill contracts); the
owner settled the recorded drift the other way: the skill now runs a **full dependency-freshness +
CVE pass** — direct deps, the Gradle wrapper, GitHub-workflow action pins, Dependabot PRs folded
in, resolved-graph verification, CVE floors with `because(CVE-…)` reasons — batched into **one
draft PR per project** on the stable branch `secure-it/dependency-refresh` (matching the 1-pager's
"single proposed change" and the owner's own dependency-upgrade workflow). The output schema is
unchanged: `alerts[]` carries per-advisory outcomes, `pullRequests[]` typically holds the single
batched entry (`alertRef: "dependency-refresh"`), and the handler's per-PR revisit scheduling now
naturally means one revisit chain per project.

## 2. Revisit delays and cap

- First revisit fires **3600s (1h)** after the breakdown handler sees a
  PR in the skill output — headroom for typical CI including slower
  integration suites.
- Skill-requested re-checks (CI pending, or post-adapt) use **1800s
  (30min)**, chosen by the skill via `scheduleRevisit.afterSeconds`.
- The cap is **2 revisits per PR**, enforced by the handler: the skill
  only ever returns `scheduleRevisit: { afterSeconds }`; the handler owns
  bumping `revisitCount` and refuses to reschedule once the incoming
  payload already carries `revisitCount >= 2`. Single owner for the
  termination guarantee.

## 3. GitHub work happens inside the skills

All GitHub reads and writes (alert scan, PR open/update, flip, rollback)
run inside the coding-agent subprocess via `gh` using the inherited
`GITHUB_TOKEN`. The handler never calls `runtime.clients.github`; the
`github` need is declared so the deployment provisions the token into the
Lambda env (subprocesses inherit it automatically).

## 4. Deploy wiring deferred

The infra registry entry exists (`infra/src/registry.ts`), but the rest
of the deploy story is deferred: the recurring cron tick (EventBridge
Scheduler → input queue), the per-agent schedule group + the IAM role the
Scheduler assumes for one-shot revisit schedules, provisioning of the
`SELF_QUEUE_URL` / `SELF_QUEUE_ARN` / `SCHEDULE_GROUP_NAME` /
`SCHEDULER_ROLE_ARN` env vars, and the Dockerfile. `src/lambda.ts`
documents the env contract those pieces must satisfy.

## 5. Other decisions

- **Revisit mounts no working copy.** PR state lives entirely on GitHub
  and the revisit skill reads/writes it via `gh`, so the handler passes
  `workingCopies: []` — no sync cost on the follow-up path.
- **Rollback = comment + close PR + delete branch.** The next scheduled
  scan picks the alert up again with a clean slate; nothing half-done
  lingers on the branch.
- **Execution overrides are carried but not applied.** Payload types
  extend `AgentPayloadBase` (so `execution` can ride along), but the
  handler doesn't spread overrides into `runSkill` — a scheduler-driven
  agent has no consumer-facing override path yet. Wire it when a caller
  exists.
- **`ciConclusion` is required** in the revisit output; the `none` enum
  value covers both "no CI configured" and "nothing to read" (e.g. the
  PR was already gone on entry).
- **Opt-in is re-checked at breakdown.** A project that opted out (or
  vanished) between the init fan-out and the breakdown delivery is
  skipped with a log line, not an error — deliveries are idempotent.
- **Support skills: `karpathy-guidelines` only.** Earlier descriptor
  drafts also listed `diagnose`; the settled contract drops it — the two
  skill bodies carry their own failure-analysis guidance.
