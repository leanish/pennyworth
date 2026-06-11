import { EntrypointInvocationError, ExecutionResolveError } from "@leanish/runtime";
import type { Project, Runtime, RuntimeMessage, WorkingCopy } from "@leanish/runtime";

import { extractEvidenceArchive, InvalidEvidenceArchiveError } from "./evidence.js";
import type { ExtractedEvidence } from "./evidence.js";
import { TriageLifecycleEmitter } from "./lifecycle-events.js";
import type { TriageEnvelope, TriagePayload } from "./payload.js";
import { parseS3Uri, parseTriageRequest, TriageValidationError } from "./request-schema.js";
import {
  deliverTerminalReply,
  type TriageCodeScope,
  type TriageErrorKind,
  type TriageFinding,
  type TriagePriorTicket,
  type TriageTerminalFailure,
  type TriageTerminalReply,
  type TriageTerminalResult,
} from "./terminal-reply.js";

/** Input handed to the `triage` skill — matches `skills/triage/SKILL.md` inputSchema. */
interface TriageSkillInput {
  readonly ticketKey: string;
  readonly customer: string;
  readonly problem?: string;
  readonly evidenceDir: string;
  readonly codeScope: TriageCodeScope;
}

/** Output of the `triage` skill — matches `skills/triage/SKILL.md` outputSchema. */
interface TriageSkillOutput {
  readonly diagnosis: string;
  readonly findings: ReadonlyArray<TriageFinding>;
  readonly suggestedNextSteps: ReadonlyArray<string>;
  readonly relevantPriorTickets: ReadonlyArray<TriagePriorTicket>;
}

/**
 * The transformation from `payload.request` (consumer-request shape) to the
 * `triage` skill's input + the surrounding lifecycle / delivery logic:
 *
 *   1. Emit `received`.
 *   2. Parse + validate the consumer request          (validation-error)
 *   3. Resolve execution defaults                     (validation-error)
 *   4. Fetch the evidence archive from S3             (io-error)
 *   5. Extract it safely to a fresh temp dir          (validation-error on
 *      an invalid archive; the extractor enforces size / count / path /
 *      entry-type caps and requires `manifest.md` at the root)
 *   6. Resolve code scope: explicit `projectIds` → catalog lookup + sync
 *      (`code+evidence`); absent → no working copies (`evidence-only`)
 *   7. `runSkill({ entrypoint: "triage", … })`
 *   8. Emit `completed`, deliver the terminal reply to `envelope.replyTo`.
 *
 * The evidence temp dir is removed in `finally` once the skill run is over
 * (the skill reads evidence lazily from disk, so cleanup can't happen
 * earlier). Every *work* fail-path emits `triage-it.triage.failed` and
 * delivers a failure reply; the one exception is a terminal-reply
 * *delivery* failure after `completed` already fired — that propagates for
 * SQS retry rather than contradicting the emitted `completed` (the reply
 * channel is at-least-once; consumers dedupe on requestId).
 *
 * **Returns the terminal reply.** AWS mode delivers it via SQS to
 * `envelope.replyTo` AND returns it (the shim discards the return value);
 * local mode surfaces it as the invocation's Promise resolution.
 */
export async function handleTriageMessage(
  message: RuntimeMessage<TriagePayload>,
  runtime: Runtime,
): Promise<TriageTerminalReply> {
  const envelope = message.payload.envelope;
  const lifecycle = new TriageLifecycleEmitter(
    runtime,
    envelope,
    peekTicketKey(message.payload.request),
  );
  const startedAt = Date.now();

  await lifecycle.received();

  // 1 — validate the consumer-request shape at the boundary.
  let request;
  try {
    request = parseTriageRequest(message.payload.request);
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }

  // 2 — resolve execution defaults (descriptor codingAgent + model). The
  // triage request carries no per-request execution override.
  let execution;
  try {
    execution = runtime.execution.resolve(undefined);
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }
  const agentField = { kind: execution.codingAgent, model: execution.model };

  // 3 — fetch the evidence archive. The collector (a separate component)
  // produced it customer-scoped + PII-filtered; this agent never holds
  // database credentials and only ever reads the bundled files.
  let archive: Uint8Array;
  try {
    if (runtime.clients.s3 === undefined) {
      throw new Error("s3 client unavailable; descriptor declares 's3' but wiring failed");
    }
    const { bucket, key } = parseS3Uri(request.evidenceBlobUri);
    const result = await runtime.clients.s3.getObject({ bucket, key });
    archive = result.body;
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }

  // 4 — extract safely to a fresh temp dir (caps + path/type rejection +
  // required manifest.md live in `evidence.ts`).
  let evidence: ExtractedEvidence;
  try {
    evidence = await extractEvidenceArchive({ archive });
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }

  // 5..7 — code scope, skill run, reply. Wrapped so the evidence dir is
  // always removed once the skill run is over (or failed).
  let reply: TriageTerminalReply;
  try {
    let workingCopies: ReadonlyArray<WorkingCopy> = [];
    let codeScope: TriageCodeScope = "evidence-only";
    if (request.projectIds !== undefined && request.projectIds.length > 0) {
      const projects = resolveProjects(request.projectIds, runtime);
      const sync = await runtime.syncWorkingCopies(projects);
      workingCopies = sync.workingCopies;
      codeScope = "code+evidence";
    } else {
      runtime.logger.info("no projectIds in request; running evidence-only triage", {
        codeScope: "evidence-only",
        ticketKey: request.ticketKey,
      });
    }

    const skillInput: TriageSkillInput = {
      ticketKey: request.ticketKey,
      customer: request.customer,
      evidenceDir: evidence.evidenceDir,
      codeScope,
      ...(request.problem !== undefined ? { problem: request.problem } : {}),
    };
    const skillResult = await runtime.runSkill<TriageSkillInput, TriageSkillOutput>({
      entrypoint: "triage",
      input: skillInput,
      workingCopies,
      ...execution,
    });

    const durationMs = Date.now() - startedAt;
    const result: TriageTerminalResult = {
      diagnosis: skillResult.diagnosis,
      findings: skillResult.findings,
      suggestedNextSteps: skillResult.suggestedNextSteps,
      relevantPriorTickets: skillResult.relevantPriorTickets,
      codeScope,
      agent: agentField,
      durationMs,
    };
    reply = { requestId: envelope.requestId, status: "completed", result };
    await lifecycle.completed({ codeScope, agent: agentField, durationMs });
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  } finally {
    await evidence.cleanup().catch((err) => {
      runtime.logger.warn("evidence cleanup failed", { error: errorMessage(err) });
    });
  }

  // Work succeeded and `completed` is emitted. Delivery happens OUTSIDE the
  // work try: the SQS reply is the load-bearing channel, so a delivery
  // failure must NOT be converted into a `failed` reply. It propagates so
  // the shim reports a batchItemFailure → SQS redelivers (at-least-once).
  await deliverTerminalReply(reply, envelope, runtime);
  return reply;
}

/**
 * Resolve explicit `projectIds` against the catalog's triage-it consumer
 * view. Any id not in (or not opted into) the catalog throws — silently
 * skipping would degrade an explicit consumer intent into a narrower
 * diagnosis without surfacing the typo / opt-out.
 */
function resolveProjects(
  projectIds: ReadonlyArray<string>,
  runtime: Runtime,
): ReadonlyArray<Project> {
  const consumer = runtime.catalog.forConsumer("triage-it");
  const projects: Project[] = [];
  const unknown: string[] = [];
  for (const id of projectIds) {
    const project = consumer.get(id);
    if (project === undefined) {
      unknown.push(id);
      continue;
    }
    projects.push(project);
  }
  if (unknown.length > 0) {
    throw new TriageValidationError(
      `request.projectIds references unknown project id${unknown.length === 1 ? "" : "s"}: [${unknown.join(", ")}]`,
    );
  }
  return projects;
}

async function failTerminal(
  runtime: Runtime,
  envelope: TriageEnvelope,
  lifecycle: TriageLifecycleEmitter,
  kind: TriageErrorKind,
  err: unknown,
): Promise<TriageTerminalFailure> {
  const message = errorMessage(err);
  await lifecycle.failed({ kind, message });
  const reply: TriageTerminalFailure = {
    requestId: envelope.requestId,
    status: "failed",
    error: { kind, message },
  };
  try {
    await deliverTerminalReply(reply, envelope, runtime);
  } catch (deliveryErr) {
    runtime.logger.error("terminal reply delivery failed", {
      error: errorMessage(deliveryErr),
    });
  }
  return reply;
}

function mapErrorKind(err: unknown): TriageErrorKind {
  if (err instanceof TriageValidationError) return "validation-error";
  if (err instanceof InvalidEvidenceArchiveError) return "validation-error";
  if (err instanceof EntrypointInvocationError) {
    if (err.reason === "input-validation-fail") return "config-error";
    return "agent-error";
  }
  if (err instanceof ExecutionResolveError) return "validation-error";
  return "io-error";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort read of `ticketKey` from the not-yet-validated request, for
 * lifecycle-event correlation only. The real validation happens in
 * `parseTriageRequest`.
 */
function peekTicketKey(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const raw = (request as Record<string, unknown>)["ticketKey"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
