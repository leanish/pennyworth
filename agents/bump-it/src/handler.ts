import type { Project, ProjectSource, Runtime, RuntimeMessage } from "@leanish/runtime";

import type { BreakdownPayload, RevisitPayload, BumpItPayload } from "./payload.js";

/** The consumer id bump-it uses for catalog reads and the opt-in extension key. */
export const CONSUMER_ID = "bump-it";

/** Delay between opening a draft PR and the first CI check (revisit). */
const FIRST_REVISIT_DELAY_SECONDS = 3600;

/**
 * Maximum number of revisits per PR. A revisit message carrying
 * `revisitCount >= REVISIT_CAP` is the last one — the handler never
 * reschedules past it, so the follow-up loop always terminates.
 */
const REVISIT_CAP = 2;

/** Input contract of the `bump-it` entry-point skill (see its SKILL.md). */
export interface BumpItInput {
  readonly project: {
    readonly id: string;
    readonly source: ProjectSource;
  };
}

export type BumpItAlertOutcome =
  | "pr-opened"
  | "pr-updated"
  | "already-fixed"
  | "unsupported"
  | "no-safe-fix";

export interface BumpItAlert {
  readonly alertRef: string;
  readonly outcome: BumpItAlertOutcome;
}

export interface BumpItPullRequest {
  readonly alertRef: string;
  readonly url: string;
  readonly branch: string;
  readonly number: number;
  readonly title: string;
}

/** Output contract of the `bump-it` entry-point skill. */
export interface BumpItOutput {
  readonly summary: string;
  /** Audit log — one entry per alert processed, all outcomes. */
  readonly alerts: ReadonlyArray<BumpItAlert>;
  /** One entry per PR opened or updated; drives revisit scheduling. */
  readonly pullRequests: ReadonlyArray<BumpItPullRequest>;
}

/** Input contract of the `bump-it-revisit` entry-point skill. */
export interface BumpItRevisitInput {
  readonly repo: string;
  readonly branch: string;
  readonly alertRef: string;
  readonly revisitCount: number;
}

export type BumpItRevisitOutcome =
  | "flipped"
  | "already-flipped"
  | "adapted"
  | "rolled-back"
  | "deferred";

export type BumpItCiConclusion = "success" | "failure" | "pending" | "none";

/** Output contract of the `bump-it-revisit` entry-point skill. */
export interface BumpItRevisitOutput {
  readonly outcome: BumpItRevisitOutcome;
  readonly ciConclusion: BumpItCiConclusion;
  /**
   * Present when the skill wants another check; the handler bumps the
   * count. `afterSeconds` must be >= 1 (the SKILL.md outputSchema
   * enforces `minimum: 1`, so a zero/negative delay fails output
   * validation instead of producing an `at(...)` schedule in the past).
   */
  readonly scheduleRevisit?: { readonly afterSeconds: number };
}

/**
 * Per-stage dispatch for bump-it. `stage` is the discriminator (the SQS
 * shim already rejected stages outside the descriptor's `stages:` list):
 *
 *   - `init` (sourceTrigger scheduler|self) — list catalog candidates,
 *     keep only explicitly opted-in projects, fan out one `breakdown`
 *     message per project via `runtime.publish`.
 *   - `breakdown` (sourceTrigger self) — re-resolve + re-check opt-in
 *     (idempotent skip when the project vanished or opted out between
 *     init and breakdown), sync the working copy, run the `bump-it`
 *     skill, then schedule one delayed `revisit` per PR it opened/updated.
 *   - `revisit` (sourceTrigger self) — run the `bump-it-revisit` skill
 *     against the PR reference carried in the payload; reschedule with a
 *     bumped `revisitCount` when the skill asks for it and the cap allows.
 *
 * All GitHub work (alert scan, PR open/update/flip/rollback) happens
 * inside the skills via `gh` with the inherited `GITHUB_TOKEN`; the
 * handler only orchestrates catalog reads, working-copy sync, skill runs,
 * and self-publishing.
 */
export async function handleBumpItMessage(
  message: RuntimeMessage<BumpItPayload>,
  runtime: Runtime,
): Promise<void> {
  switch (message.stage) {
    case "init":
      return handleInit(runtime);
    case "breakdown":
      return handleBreakdown(asBreakdownPayload(message.payload), runtime);
    case "revisit":
      return handleRevisit(asRevisitPayload(message.payload), runtime);
  }
}

/**
 * Explicit opt-in check for a write-capable agent: catalog membership
 * (the default-on `forConsumer` view) is necessary but not sufficient.
 * Only the literal boolean `extensions["bump-it"].enabled === true`
 * makes a project eligible — absence, `false`, and non-boolean truthy
 * values are all out.
 */
export function isExplicitlyOptedIn(project: Project): boolean {
  const slice = project.extensions?.[CONSUMER_ID];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) return false;
  return (slice as Record<string, unknown>)["enabled"] === true;
}

async function handleInit(runtime: Runtime): Promise<void> {
  const candidates = runtime.catalog.forConsumer(CONSUMER_ID).list();
  const eligible = candidates.filter(isExplicitlyOptedIn);
  runtime.logger.info("bump-it: init fan-out", {
    catalogCandidates: candidates.length,
    eligible: eligible.length,
  });
  for (const project of eligible) {
    await runtime.publish({ stage: "breakdown", payload: { projectId: project.id } });
  }
}

async function handleBreakdown(payload: BreakdownPayload, runtime: Runtime): Promise<void> {
  const project = runtime.catalog.forConsumer(CONSUMER_ID).get(payload.projectId);
  if (project === undefined || !isExplicitlyOptedIn(project)) {
    // Idempotent skip — the project disappeared or opted out between the
    // init fan-out and this delivery. Not an error; just don't act.
    runtime.logger.info("bump-it: skipping breakdown — project missing or not opted in", {
      projectId: payload.projectId,
    });
    return;
  }

  const sync = await runtime.syncWorkingCopies([project]);
  const output = await runtime.runSkill<BumpItInput, BumpItOutput>({
    entrypoint: "bump-it",
    input: { project: { id: project.id, source: project.source } },
    workingCopies: sync.workingCopies,
  });
  runtime.logger.info("bump-it: breakdown complete", {
    projectId: project.id,
    alerts: output.alerts.length,
    pullRequests: output.pullRequests.length,
  });

  for (const pr of output.pullRequests) {
    await runtime.publishDelayed({
      stage: "revisit",
      afterSeconds: FIRST_REVISIT_DELAY_SECONDS,
      payload: {
        repo: project.id,
        branch: pr.branch,
        alertRef: pr.alertRef,
        revisitCount: 0,
      },
    });
  }
}

async function handleRevisit(payload: RevisitPayload, runtime: Runtime): Promise<void> {
  const output = await runtime.runSkill<BumpItRevisitInput, BumpItRevisitOutput>({
    entrypoint: "bump-it-revisit",
    input: {
      repo: payload.repo,
      branch: payload.branch,
      alertRef: payload.alertRef,
      revisitCount: payload.revisitCount,
    },
    // PR state lives entirely on GitHub; the skill reads it via `gh`,
    // so no working copy is mounted for revisit.
    workingCopies: [],
  });
  runtime.logger.info("bump-it: revisit complete", {
    repo: payload.repo,
    alertRef: payload.alertRef,
    outcome: output.outcome,
    ciConclusion: output.ciConclusion,
    revisitCount: payload.revisitCount,
  });

  if (output.scheduleRevisit === undefined) return;
  if (payload.revisitCount >= REVISIT_CAP) {
    runtime.logger.info("bump-it: revisit cap reached — not rescheduling", {
      repo: payload.repo,
      alertRef: payload.alertRef,
      revisitCount: payload.revisitCount,
      cap: REVISIT_CAP,
    });
    return;
  }
  await runtime.publishDelayed({
    stage: "revisit",
    afterSeconds: output.scheduleRevisit.afterSeconds,
    payload: {
      repo: payload.repo,
      branch: payload.branch,
      alertRef: payload.alertRef,
      revisitCount: payload.revisitCount + 1,
    },
  });
}

// Wire-boundary guards: self-published payloads round-trip through SQS as
// JSON, so the handler re-validates the shape it depends on instead of
// trusting the cast. A malformed message fails loudly (SQS retry → DLQ)
// rather than acting on garbage.

function asBreakdownPayload(payload: BumpItPayload): BreakdownPayload {
  const candidate = payload as Partial<BreakdownPayload>;
  if (typeof candidate.projectId !== "string" || candidate.projectId.length === 0) {
    throw new Error("bump-it: breakdown payload requires a non-empty string 'projectId'");
  }
  return candidate as BreakdownPayload;
}

function asRevisitPayload(payload: BumpItPayload): RevisitPayload {
  const candidate = payload as Partial<RevisitPayload>;
  const stringsOk =
    isNonEmptyString(candidate.repo) &&
    isNonEmptyString(candidate.branch) &&
    isNonEmptyString(candidate.alertRef);
  const countOk =
    typeof candidate.revisitCount === "number" &&
    Number.isInteger(candidate.revisitCount) &&
    candidate.revisitCount >= 0;
  if (!stringsOk || !countOk) {
    throw new Error(
      "bump-it: revisit payload requires non-empty strings 'repo', 'branch', 'alertRef' " +
        "and a non-negative integer 'revisitCount'",
    );
  }
  return candidate as RevisitPayload;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
