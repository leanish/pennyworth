import type { Project, Runtime, RuntimeMessage } from "@leanish/runtime";

import type { DocumentItBreakdownPayload, DocumentItPayload } from "./payload.js";

/** The catalog consumer namespace document-it reads (`extensions["document-it"]`). */
export const DOCUMENT_IT_CONSUMER_ID = "document-it";

/**
 * Project → published-docs mapping, read from
 * `extensions["document-it"].docSet`. PROVISIONAL shape — see
 * `ASSUMPTIONS.md`: the catalog does not define this descriptor yet, so
 * the handler narrows defensively and passes `{}` through when absent.
 */
export interface DocSet {
  readonly space?: string;
  readonly pageIds?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<string>;
}

/** Drift classification shared by both write surfaces. */
export type DriftType = "stale" | "wrong" | "missing";

/** A doc claim in the repo that no longer matches the code. */
export interface InRepoDriftFinding {
  readonly type: DriftType;
  readonly location: string;
  readonly claim: string;
  readonly correction: string;
  readonly confidence: number;
}

/**
 * A published-page claim that no longer matches the code. v1 surfaces
 * these as suggestions in the skill output only — the posting channel is
 * a deferred seam (see `ASSUMPTIONS.md`).
 */
export interface PublishedDriftFinding {
  readonly type: DriftType;
  readonly location: string;
  readonly claim: string;
  readonly suggestion: string;
  readonly confidence: number;
}

/** Input contract of the `verify-docs` entry-point skill. */
export interface VerifyDocsInput {
  readonly project: {
    readonly id: string;
    readonly source: {
      readonly url: string;
      readonly branch?: string;
    };
  };
  readonly docSet: DocSet;
}

/** Output contract of the `verify-docs` entry-point skill. */
export interface VerifyDocsOutput {
  readonly summary: string;
  readonly inRepoDrift: ReadonlyArray<InRepoDriftFinding>;
  readonly publishedDrift: ReadonlyArray<PublishedDriftFinding>;
  readonly pullRequest?: {
    readonly url: string;
    readonly branch: string;
  };
}

/**
 * Stage dispatch for document-it:
 *
 *   init      → list opted-in projects, publish one breakdown message each
 *   breakdown → sync the project's working copy, run `verify-docs`, log a
 *               structured audit summary (no further fan-out)
 *
 * The stage discriminator lives on the message, not in the payload, so the
 * breakdown arm narrows the payload union with a cast at this boundary.
 */
export async function handleDocumentItMessage(
  message: RuntimeMessage<DocumentItPayload>,
  runtime: Runtime,
): Promise<void> {
  switch (message.stage) {
    case "init":
      return handleInit(runtime);
    case "breakdown":
      return handleBreakdown(message.payload as DocumentItBreakdownPayload, runtime);
    default:
      // The SQS shim rejects stages outside the descriptor's declared
      // [init, breakdown] before dispatch; this guard only documents that
      // the handler makes no claim about other stages.
      runtime.logger.warn("document-it: undeclared stage; ignoring", {
        stage: message.stage,
      });
      return;
  }
}

/**
 * Scheduler tick: fan out one breakdown message per eligible project.
 *
 * Eligibility is STRICTER than catalog membership: `forConsumer(...)` is
 * default-on (only an explicit `enabled: false` excludes), but document-it
 * writes, so it requires an explicit `extensions["document-it"].enabled
 * === true` — absence is NOT enough.
 */
async function handleInit(runtime: Runtime): Promise<void> {
  const candidates = runtime.catalog.forConsumer(DOCUMENT_IT_CONSUMER_ID).list();
  const eligible = candidates.filter(isExplicitlyEnabled);
  for (const project of eligible) {
    await runtime.publish({
      stage: "breakdown",
      payload: { projectId: project.id },
    });
  }
  runtime.logger.info("document-it: init fan-out complete", {
    candidateCount: candidates.length,
    publishedCount: eligible.length,
  });
}

/** One project's doc audit: sync → verify-docs → structured summary log. */
async function handleBreakdown(
  payload: DocumentItBreakdownPayload,
  runtime: Runtime,
): Promise<void> {
  const projectId = payload.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) {
    runtime.logger.error("document-it: breakdown payload has no usable projectId; dropping", {});
    return;
  }

  const project = runtime.catalog.forConsumer(DOCUMENT_IT_CONSUMER_ID).get(projectId);
  if (project === undefined) {
    runtime.logger.warn("document-it: project not found in catalog view; skipping audit", {
      projectId,
    });
    return;
  }
  if (!isExplicitlyEnabled(project)) {
    runtime.logger.info("document-it: project not explicitly opted in; skipping audit", {
      projectId,
    });
    return;
  }

  const sync = await runtime.syncWorkingCopies([project]);
  const input: VerifyDocsInput = {
    project: {
      id: project.id,
      source: { url: project.source.url, branch: project.source.branch },
    },
    docSet: extractDocSet(project),
  };
  const output = await runtime.runSkill<VerifyDocsInput, VerifyDocsOutput>({
    entrypoint: "verify-docs",
    input,
    workingCopies: sync.workingCopies,
  });

  runtime.logger.info("document-it: audit complete", {
    projectId,
    summary: output.summary,
    inRepoDrift: countByType(output.inRepoDrift),
    publishedDrift: countByType(output.publishedDrift),
    ...(output.pullRequest !== undefined
      ? {
          pullRequestUrl: output.pullRequest.url,
          pullRequestBranch: output.pullRequest.branch,
        }
      : {}),
  });
}

/**
 * Strict opt-in check: only an explicit `extensions["document-it"].enabled
 * === true` counts. A missing slice, a non-object slice, or any other
 * `enabled` value (including absence) is out.
 */
function isExplicitlyEnabled(project: Project): boolean {
  const slice = project.extensions[DOCUMENT_IT_CONSUMER_ID];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) return false;
  return (slice as Record<string, unknown>)["enabled"] === true;
}

/**
 * Defensive narrowing of `extensions["document-it"].docSet` to the
 * provisional `DocSet` shape. Only well-typed fields pass through, so a
 * malformed catalog entry degrades to `{}` (repo-only audit) rather than
 * failing the skill's input validation.
 */
function extractDocSet(project: Project): DocSet {
  const slice = project.extensions[DOCUMENT_IT_CONSUMER_ID];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) return {};
  const raw = (slice as Record<string, unknown>)["docSet"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const space = record["space"];
  const pageIds = record["pageIds"];
  const labels = record["labels"];
  return {
    ...(typeof space === "string" ? { space } : {}),
    ...(isStringArray(pageIds) ? { pageIds } : {}),
    ...(isStringArray(labels) ? { labels } : {}),
  };
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

interface DriftCounts {
  readonly total: number;
  readonly stale: number;
  readonly wrong: number;
  readonly missing: number;
}

function countByType(findings: ReadonlyArray<{ readonly type: DriftType }>): DriftCounts {
  const counts = { total: findings.length, stale: 0, wrong: 0, missing: 0 };
  for (const finding of findings) {
    counts[finding.type] += 1;
  }
  return counts;
}
