import type { ConsumerCatalogView } from "@leanish/catalog-it";
import type { Logger } from "@leanish/runtime";
import type { ShipItRequest } from "@leanish/ship-it";

import { filtered, isShipItOptedIn, type NormalizeResult } from "./normalize-result.js";

/**
 * SYNTHETIC ticket status carried on PR-driven events. PRs have no ticket
 * workflow status, so the normalizer emits this constant and projects map
 * it to the `review-it` step via `extensions.ship-it.statusSkillMap` when
 * review-it releases (see ASSUMPTIONS.md §5).
 */
export const PR_READY_FOR_REVIEW_STATUS = "PR Ready for Review";

/**
 * GitHub `pull_request` webhook → `ShipItRequest` normalizer.
 *
 * Gates, in order:
 *   - action must be `ready_for_review` or `synchronize` — nothing else.
 *   - `pull_request.draft === false` strictly: a draft `synchronize` is
 *     filtered, which prevents review-it from firing on every push to a
 *     draft ship-it PR.
 *   - repo `full_name` (which IS the catalog projectId) must pass the
 *     strict catalog opt-in.
 *   - ticketKey parsed from the head branch `ship-it/<ticketKey>`; a parse
 *     failure is filtered (logged), not an error — human branches flow
 *     through this webhook too.
 */
export interface GitHubNormalizeContext {
  /** ship-it's consumer-scoped catalog view (`catalog.forConsumer("ship-it")`). */
  readonly catalogView: ConsumerCatalogView;
  readonly logger: Logger;
}

const ADMITTED_ACTIONS = new Set(["ready_for_review", "synchronize"]);
const TICKET_BRANCH_PATTERN = /^ship-it\/(.+)$/;

export function normalizeGitHubEvent(
  body: unknown,
  context: GitHubNormalizeContext,
): NormalizeResult {
  if (!isObject(body)) {
    return filtered("malformed-body");
  }

  const action = body["action"];
  if (typeof action !== "string" || !ADMITTED_ACTIONS.has(action)) {
    return filtered("unsupported-action", { action: action ?? null });
  }

  const pullRequest = asObject(body["pull_request"]);
  if (pullRequest === undefined) {
    return filtered("malformed-event", { action });
  }
  if (pullRequest["draft"] !== false) {
    return filtered("draft-pr", { action, draft: pullRequest["draft"] ?? null });
  }

  const projectId = nonEmptyString(asObject(body["repository"])?.["full_name"]);
  if (projectId === undefined) {
    return filtered("malformed-event", { action });
  }
  if (!isShipItOptedIn(context.catalogView, projectId)) {
    return filtered("not-opted-in", { projectId });
  }

  const headRef = nonEmptyString(asObject(pullRequest["head"])?.["ref"]);
  const ticketKey = headRef === undefined ? undefined : TICKET_BRANCH_PATTERN.exec(headRef)?.[1];
  if (ticketKey === undefined) {
    return filtered("ticket-key-parse-failed", { projectId, headRef: headRef ?? null });
  }

  const ticketSummary = nonEmptyString(pullRequest["title"]);
  const prNumber = pullRequest["number"];
  if (ticketSummary === undefined || !isPositiveInteger(prNumber)) {
    return filtered("missing-required-fields", { projectId, headRef });
  }

  const request: ShipItRequest = {
    ticketKey,
    projectId,
    ticketStatus: PR_READY_FOR_REVIEW_STATUS,
    // PRs carry no ticket labels; repo opt-in is the admission control.
    labels: [],
    ticketSummary,
    prNumber,
    trigger: { source: "github", mode: "pull-request" },
  };
  return { outcome: "normalized", request, endUser: githubEndUser(body, context.logger) };
}

/** `github:<sender.login>`, falling back to `github:unknown` (warn-logged). */
function githubEndUser(body: Record<string, unknown>, logger: Logger): string {
  const login = nonEmptyString(asObject(body["sender"])?.["login"]);
  if (login === undefined) {
    logger.warn("ship-it-normalizer: github event carries no sender.login; using github:unknown");
    return "github:unknown";
  }
  return `github:${login}`;
}

function isPositiveInteger(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0;
}

function nonEmptyString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  return isObject(raw) ? raw : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
