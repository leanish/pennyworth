import type { Project, Runtime, RuntimeMessage } from "@leanish/runtime";

import {
  parseShipItRevisitPayload,
  type ShipItInitPayload,
  type ShipItPayload,
  type ShipItRevisitPayload,
} from "./payload.js";
import { parseShipItRequest, type ShipItRequest } from "./request-schema.js";
import { SHIP_IT_STEPS } from "./steps.js";

/** Consumer id under which projects opt in (`extensions.ship-it`). */
const SHIP_IT_CONSUMER_ID = "ship-it";
/** Per-ticket opt-in label, re-asserted in-handler (defense in depth). */
const SHIP_IT_TICKET_LABEL = "ship-it";
/**
 * Ticket status → step, unless the project overrides it. Status names are
 * tenant-specific placeholders — projects override the whole map via
 * `extensions.ship-it.statusSkillMap`. Entries routing to dark steps are
 * harmless (advisory skip) and become live when the step is released.
 */
const DEFAULT_STATUS_SKILL_MAP: Readonly<Record<string, string>> = {
  "To Groom": "groom-it",
  "Ready for Implementation": "code-it",
};
/** Delay before the first CI revisit after code-it opens a draft PR. */
const FIRST_REVISIT_DELAY_SECONDS = 3600;
/** Revisit cycle budget: a revisit with `revisitCount >= 3` never reschedules. */
const MAX_REVISIT_COUNT = 3;

interface CodeItInput {
  readonly ticketKey: string;
  readonly ticketSummary: string;
  readonly ticketDescription?: string;
  readonly acceptanceCriteria?: ReadonlyArray<string>;
  readonly project: {
    readonly id: string;
    readonly source: { readonly url: string; readonly branch?: string };
  };
}

interface CodeItOutput {
  readonly outcome: "pr-opened" | "clarification-needed" | "deferred";
  readonly pullRequest?: {
    readonly url: string;
    readonly number: number;
    readonly branch: string;
  };
  readonly notes: string;
}

interface CodeItRevisitInput {
  readonly ticketKey: string;
  /** Catalog project id (owner/repo) — the skill's `--repo` for every gh call. */
  readonly projectId: string;
  readonly prNumber: number;
  readonly branch: string;
  readonly revisitCount: number;
}

interface CodeItRevisitOutput {
  readonly outcome: "flipped" | "already-flipped" | "adapted" | "rolled-back" | "deferred";
  readonly ciConclusion: "success" | "failure" | "pending" | "none";
  readonly scheduleRevisit?: { readonly afterSeconds: number };
}

interface GroomItInput {
  readonly ticketKey: string;
  readonly projectId: string;
  readonly ticketSummary: string;
  readonly ticketDescription?: string;
  readonly acceptanceCriteria?: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
}

interface GroomItOutput {
  readonly outcome: "ready" | "needs-work";
  readonly findings: ReadonlyArray<{
    readonly aspect: "clarity" | "actionability" | "scope" | "acceptance-criteria" | "standardization";
    readonly issue: string;
    readonly suggestion: string;
  }>;
  readonly notes: string;
}

interface SpecItInput {
  readonly ticketKey: string;
  readonly ticketSummary: string;
  readonly ticketDescription?: string;
  readonly acceptanceCriteria?: ReadonlyArray<string>;
  readonly project: {
    readonly id: string;
    readonly source: { readonly url: string; readonly branch?: string };
  };
}

interface SpecItOutput {
  readonly outcome: "specced" | "refined" | "clarification-needed";
  readonly specDraft: string;
  readonly openQuestions: ReadonlyArray<string>;
  readonly suggestReady: boolean;
  readonly notes: string;
}

interface ReviewItInput {
  readonly projectId: string;
  readonly prNumber: number;
  readonly ticketKey?: string;
}

interface ReviewItOutput {
  readonly outcome: "reviewed" | "skipped";
  readonly verificationMode: "cross-model-consensus" | "single-model";
  readonly findings: ReadonlyArray<{
    readonly severity: "blocker" | "major" | "minor" | "nit";
    readonly file?: string;
    readonly title: string;
    readonly detail: string;
  }>;
  readonly summary: string;
  readonly postedReview: boolean;
}

/**
 * ship-it's stage dispatcher.
 *
 *   - `init` — consumer envelope from the webhook normalizer. Gate, select
 *     the skill by ticket status, run `code-it`, and (on a PR) schedule the
 *     first CI revisit.
 *   - `revisit` — self-published message (ADR-0011). Run `code-it-revisit`
 *     and reschedule while the skill asks for it and the cycle budget holds.
 *
 * Gate misses and unknown statuses are advisory skips (log + return) — the
 * message is done, not failed. Malformed payloads throw
 * `ShipItValidationError` instead: they propagate so the shim reports a
 * batch item failure and the message eventually lands on the DLQ where
 * operators can triage the normalizer (or publisher) bug.
 */
export async function handleShipItMessage(
  message: RuntimeMessage<ShipItPayload>,
  runtime: Runtime,
): Promise<void> {
  switch (message.stage) {
    case "init":
      return handleInit(message.payload as ShipItInitPayload, runtime);
    case "revisit":
      return handleRevisit(message.payload, runtime);
    default:
      // Unreachable behind the dispatcher's descriptor-stage check; explicit
      // so a future stage addition fails loudly instead of silently no-oping.
      throw new Error(`ship-it: unsupported stage '${message.stage}'`);
  }
}

async function handleInit(payload: ShipItInitPayload, runtime: Runtime): Promise<void> {
  const request = parseShipItRequest(payload.request);
  const log = runtime.logger.with({
    ticketKey: request.ticketKey,
    projectId: request.projectId,
  });

  // Gate 1 — strict repo opt-in: the project must exist in ship-it's
  // catalog view AND carry an explicit `extensions.ship-it.enabled: true`.
  // Stricter than the catalog's default-on consumer filter, deliberately:
  // ship-it is write-capable, so absence of the flag means "not opted in".
  const project = runtime.catalog.forConsumer(SHIP_IT_CONSUMER_ID).get(request.projectId);
  if (project === undefined) {
    log.info("ship-it: skipping — project not in the ship-it catalog view");
    return;
  }
  const extension = shipItExtension(project);
  if (extension?.["enabled"] !== true) {
    log.info(
      "ship-it: skipping — project has no explicit extensions.ship-it.enabled === true",
    );
    return;
  }

  // Gate 2 — per-ticket opt-in label, re-asserted even though the webhook
  // normalizer should have filtered already (defense in depth).
  if (!request.labels.includes(SHIP_IT_TICKET_LABEL)) {
    log.info("ship-it: skipping — ticket does not carry the 'ship-it' label", {
      labels: request.labels,
    });
    return;
  }

  // Step selection — the ticket's workflow status picks the step. A
  // project may override the default map via extensions.ship-it.statusSkillMap.
  const statusSkillMap = resolveStatusSkillMap(extension);
  const stepName = statusSkillMap[request.ticketStatus];
  if (stepName === undefined) {
    // Advisory skip, not an error: tickets move through many statuses and
    // only the mapped ones are ship-it's business.
    log.info("ship-it: skipping — no step mapped for ticket status", {
      ticketStatus: request.ticketStatus,
    });
    return;
  }

  // Per-step release switch (src/steps.ts): steps are developed and merged
  // dark, then released by flipping one boolean. Routing to a dark or
  // unknown step is an advisory skip, never a failure.
  const step = SHIP_IT_STEPS[stepName];
  if (step === undefined) {
    log.warn("ship-it: skipping — mapped step is not in the step registry", {
      ticketStatus: request.ticketStatus,
      step: stepName,
    });
    return;
  }
  if (!step.released) {
    log.info("ship-it: skipping — step is not released yet", {
      ticketStatus: request.ticketStatus,
      step: stepName,
      note: step.note,
    });
    return;
  }
  const runStep = STEP_RUNNERS[stepName];
  if (runStep === undefined) {
    // Registry/runner drift — released without an implementation. Skip
    // loudly instead of failing the ticket; the registry test pins this.
    log.error("ship-it: skipping — released step has no runner", { step: stepName });
    return;
  }

  await runStep(request, project, runtime, log);
}

/**
 * Implementation dispatch for RELEASED steps. Adding a step: implement its
 * runner + skills, register it here, and flip `released` in steps.ts when
 * it's ready for real traffic.
 */
const STEP_RUNNERS: Readonly<
  Record<
    string,
    (
      request: ShipItRequest,
      project: Project,
      runtime: Runtime,
      log: Runtime["logger"],
    ) => Promise<void>
  >
> = {
  "code-it": runCodeIt,
  // Implemented but DARK (released: false in steps.ts) — flipping the
  // registry boolean is the launch switch for each of these.
  "groom-it": runGroomIt,
  "spec-it": runSpecIt,
  "review-it": runReviewIt,
};

/**
 * groom-it: assess the ticket against scrum-standard quality and propose a
 * groomed rewrite. Pure ticket work — no working copy, no fan-out.
 */
async function runGroomIt(
  request: ShipItRequest,
  _project: Project,
  runtime: Runtime,
  log: Runtime["logger"],
): Promise<void> {
  const output = await runtime.runSkill<GroomItInput, GroomItOutput>({
    entrypoint: "groom-it",
    input: {
      ticketKey: request.ticketKey,
      projectId: request.projectId,
      ticketSummary: request.ticketSummary,
      ...(request.ticketDescription !== undefined
        ? { ticketDescription: request.ticketDescription }
        : {}),
      ...(request.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: request.acceptanceCriteria }
        : {}),
      labels: request.labels,
    },
    workingCopies: [],
  });
  log.info("ship-it: groom-it finished", {
    outcome: output.outcome,
    findings: output.findings.length,
  });
}

/**
 * spec-it: refine the ticket's specification, grounded in the project's
 * code (working copy mounted). Advisory; humans iterate and transition.
 */
async function runSpecIt(
  request: ShipItRequest,
  project: Project,
  runtime: Runtime,
  log: Runtime["logger"],
): Promise<void> {
  const sync = await runtime.syncWorkingCopies([project]);
  const output = await runtime.runSkill<SpecItInput, SpecItOutput>({
    entrypoint: "spec-it",
    input: {
      ticketKey: request.ticketKey,
      ticketSummary: request.ticketSummary,
      ...(request.ticketDescription !== undefined
        ? { ticketDescription: request.ticketDescription }
        : {}),
      ...(request.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: request.acceptanceCriteria }
        : {}),
      project: {
        id: project.id,
        source: {
          url: project.source.url,
          ...(project.source.branch !== undefined ? { branch: project.source.branch } : {}),
        },
      },
    },
    workingCopies: sync.workingCopies,
  });
  log.info("ship-it: spec-it finished", {
    outcome: output.outcome,
    openQuestions: output.openQuestions.length,
    suggestReady: output.suggestReady,
  });
}

/**
 * review-it: independent review of a ready-for-review PR — cross-model
 * consensus when the environment provides it, single-model otherwise (the
 * skill reports which via `verificationMode`). Requires `prNumber` on the
 * event; PR-less events are advisory skips.
 */
async function runReviewIt(
  request: ShipItRequest,
  project: Project,
  runtime: Runtime,
  log: Runtime["logger"],
): Promise<void> {
  if (request.prNumber === undefined) {
    log.warn("ship-it: skipping review-it — event carries no prNumber", {
      ticketStatus: request.ticketStatus,
    });
    return;
  }
  const sync = await runtime.syncWorkingCopies([project]);
  const output = await runtime.runSkill<ReviewItInput, ReviewItOutput>({
    entrypoint: "review-it",
    input: {
      projectId: request.projectId,
      prNumber: request.prNumber,
      ticketKey: request.ticketKey,
    },
    workingCopies: sync.workingCopies,
  });
  log.info("ship-it: review-it finished", {
    outcome: output.outcome,
    verificationMode: output.verificationMode,
    findings: output.findings.length,
    postedReview: output.postedReview,
  });
}

async function runCodeIt(
  request: ShipItRequest,
  project: Project,
  runtime: Runtime,
  log: Runtime["logger"],
): Promise<void> {
  const sync = await runtime.syncWorkingCopies([project]);
  const input: CodeItInput = {
    ticketKey: request.ticketKey,
    ticketSummary: request.ticketSummary,
    ...(request.ticketDescription !== undefined
      ? { ticketDescription: request.ticketDescription }
      : {}),
    ...(request.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: request.acceptanceCriteria }
      : {}),
    project: { id: project.id, source: project.source },
  };
  const output = await runtime.runSkill<CodeItInput, CodeItOutput>({
    entrypoint: "code-it",
    input,
    workingCopies: sync.workingCopies,
  });

  if (output.outcome !== "pr-opened") {
    // clarification-needed / deferred: the skill already said its piece on
    // the ticket; nothing to revisit.
    log.info("ship-it: code-it finished without a PR; no revisit scheduled", {
      outcome: output.outcome,
      notes: output.notes,
    });
    return;
  }
  if (output.pullRequest === undefined) {
    // Schema can't express "pullRequest required iff pr-opened"; guard here.
    log.warn(
      "ship-it: code-it reported pr-opened without pullRequest details; cannot schedule a revisit",
      { notes: output.notes },
    );
    return;
  }

  await runtime.publishDelayed({
    stage: "revisit",
    afterSeconds: FIRST_REVISIT_DELAY_SECONDS,
    payload: {
      ticketKey: request.ticketKey,
      projectId: project.id,
      prNumber: output.pullRequest.number,
      branch: output.pullRequest.branch,
      revisitCount: 0,
    },
  });
  log.info("ship-it: code-it opened a draft PR; first revisit scheduled", {
    prNumber: output.pullRequest.number,
    branch: output.pullRequest.branch,
    afterSeconds: FIRST_REVISIT_DELAY_SECONDS,
  });
}

async function handleRevisit(raw: unknown, runtime: Runtime): Promise<void> {
  const payload: ShipItRevisitPayload = parseShipItRevisitPayload(raw);
  const log = runtime.logger.with({
    ticketKey: payload.ticketKey,
    prNumber: payload.prNumber,
    revisitCount: payload.revisitCount,
  });

  const output = await runtime.runSkill<CodeItRevisitInput, CodeItRevisitOutput>({
    entrypoint: "code-it-revisit",
    input: {
      ticketKey: payload.ticketKey,
      projectId: payload.projectId,
      prNumber: payload.prNumber,
      branch: payload.branch,
      revisitCount: payload.revisitCount,
    },
    workingCopies: [],
  });

  if (output.scheduleRevisit === undefined) {
    log.info("ship-it: revisit settled; no further revisit requested", {
      outcome: output.outcome,
      ciConclusion: output.ciConclusion,
    });
    return;
  }
  if (payload.revisitCount >= MAX_REVISIT_COUNT) {
    log.warn(
      "ship-it: revisit cycle budget exhausted; leaving the draft PR for a human",
      { outcome: output.outcome, ciConclusion: output.ciConclusion },
    );
    return;
  }

  await runtime.publishDelayed({
    stage: "revisit",
    afterSeconds: output.scheduleRevisit.afterSeconds,
    payload: {
      ticketKey: payload.ticketKey,
      projectId: payload.projectId,
      prNumber: payload.prNumber,
      branch: payload.branch,
      revisitCount: payload.revisitCount + 1,
    },
  });
  log.info("ship-it: revisit rescheduled", {
    outcome: output.outcome,
    ciConclusion: output.ciConclusion,
    afterSeconds: output.scheduleRevisit.afterSeconds,
  });
}

/** The project's `extensions["ship-it"]` slice when it is an object; else undefined. */
function shipItExtension(project: Project): Record<string, unknown> | undefined {
  const slice = project.extensions[SHIP_IT_CONSUMER_ID];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    return undefined;
  }
  return slice as Record<string, unknown>;
}

/**
 * A project-supplied `statusSkillMap` REPLACES the default (no merge): a
 * project that maps statuses explicitly owns the whole mapping.
 */
function resolveStatusSkillMap(
  extension: Record<string, unknown>,
): Readonly<Record<string, string>> {
  const raw = extension["statusSkillMap"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_STATUS_SKILL_MAP;
  }
  return raw as Record<string, string>;
}
