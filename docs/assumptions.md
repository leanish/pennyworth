# Assumptions record — agent build-out

Decisions made during the implementation of the agent fleet that were **not** settled by prior design
docs. Each was validated in an adversarial review loop at implementation time; the important ones
deserve a human pass. Per-agent assumptions live in each agent's `ASSUMPTIONS.md`; this file carries
the core/cross-cutting set.

## Core runtime

- **A-CORE-1 — Self/scheduler messages are unsigned.** Bodies whose `metadata.sourceTrigger` is
  `"self"` or `"scheduler"` skip envelope verification: the input queue is IAM-private to the agent
  and its Scheduler role, so signing (a consumer-boundary control) doesn't apply. Guard: an agent that
  ALSO declares a `signedEnvelope` consumer trigger rejects unsigned runtime-message bodies unless the
  entry shim sets `allowUnsignedRuntimeMessagesWithConsumerTrigger: true` (documented trust
  acknowledgment — otherwise a consumer with SendMessage on the queue could forge them).
- **A-CORE-2 — Schedule identity excludes the delay.** `publishDelayed` derives the one-shot schedule
  name from `{agentId, stage, payload}` only; re-publishing the same logical payload with a different
  `afterSeconds` dedupes onto the first schedule. Callers needing a distinct pending schedule must
  change the payload identity. `ConflictException` is treated as success without target verification.
- **A-CORE-3 — Infra synths with the widest phase.** `agent-infra` parses every registered descriptor
  with `phase: "phase-3"`; phase admissibility is enforced at agent startup, not synth.
- **A-CORE-4 — Deploy-readiness is out of scope.** Registry entries added by agent PRs are "synth
  roster only": EventBridge Scheduler IAM (CreateSchedule + the per-agent target role), the recurring
  init-tick provisioning, secret-backed env resolution for github/jira, and per-agent Dockerfiles all
  land with the deploy follow-up.
- **A-CORE-5 — run-local fan-out drain deferred.** `createLocalSelfPublisher` ships for tests and
  custom shims; wiring a drain loop into `run-local-cli` (high configurable depth cap) is a follow-up.
- **A-CORE-6 — `jira` need is a placeholder client.** Like `github`, the typed client is a marker
  (`{kind: "jira"}`); skills do the real Jira work in the subprocess with resolved credentials.
- **A-CORE-7 — Target-project credentials are env-var-only (v1).** The `target-credentials` need
  resolves a project's `extensions.credentials` (CodeArtifact derived tokens, SSM stored secrets)
  into subprocess env vars. No tool-config-file materialization (`~/.npmrc`, `~/.m2/settings.xml`)
  — target builds are expected to reference env vars. Clone-time credentials for private repos are
  explicitly NOT covered (the workspace clones before any skill runs); that's a future
  `github-app` provider.
- **A-CORE-8 — Coding-agent subprocesses don't inherit the role's AWS credentials.** The runners
  scrub the AWS credential env vars from the inherited base (`SCRUBBED_AWS_ENV_VARS`) so the model
  subprocess can't ambiently exercise the Lambda role (e.g. read other projects' SSM secrets once
  `target-credentials` is granted). Deliberate re-add via the runner's `options.env` is the
  operator escape hatch (e.g. a Bedrock-auth CLI); catalog data can never re-add them (the
  credentials schema bans the `AWS_` prefix). Residual risk stays documented: a prompt-injected
  agent echoing its *injected* env is mitigated by least exposure, read-only tokens, output
  redaction, and the human gate — not eliminated.
- **A-CORE-9 — CodeArtifact tokens ride the 12 h default TTL.** No `durationSeconds` override; the
  warm-container cache reuses a minted token while `expiration − 10 min` is ahead. Cross-account
  domains additionally require the domain's resource policy to allow the suite account, and
  project SecureStrings are assumed encrypted with the suite's shared KMS key (operator
  convention) — both are deploy-time prerequisites outside this repo.

## Cross-cutting

- **A-X-1 — Naming aligned to folders.** Nothing is deployed, so identifiers/skills use dashed names
  (`bump-it`, `document-it`, `triage-it`, `ship-it`; skills `bump-it`, `bump-it-revisit`, …).
  The old `secureit` placeholder identifier is migrated.
- **A-X-2 — Agent-owned entrypoint skills.** Entry-point skills live in each agent's own `skills/`
  dir (the ask-the-code pattern; loader precedence already supports it). Supersedes the older note
  that secure-it's skills would be bundled in the runtime.
- **A-X-3 — Opt-in keys.** Write-capable agents gate on `extensions["<agent-id>"].enabled === true`
  (strict `true`). Read-only mediated agents (ask-the-code, triage-it) rely on catalog membership +
  consumer scoping.
- **A-X-4 — Revisit budgets.** bump-it: first revisit 3600s, pending re-check 1800s, revisitCount
  cap 2 (per spec). ship-it code-it: cycle budget 3 (chosen, not spec'd).
- **A-X-5 — bump-it one-pager vs skill-spec drift.** The one-pager says "one batched update PR";
  the skill specs define per-alert draft PRs on `bump-it/<alertRef>` branches. Implementation
  follows the skill specs (the engineering contract); the one-pager reads as plain-language
  simplification. Owner review requested.
- **A-X-6 — Image-tag env vars use underscores** (`BUMP_IT_IMAGE_TAG`, …).
