import type { ConsumerCatalogView } from "@leanish/catalog-it";
import type { Logger } from "@leanish/runtime";
import type { ShipItRequest, ShipItTrigger } from "@leanish/ship-it";

import { filtered, isShipItOptedIn, type NormalizeResult } from "./normalize-result.js";

/**
 * Jira webhook → `ShipItRequest` normalizer. Supported events:
 * issue-updated / issue-labeled / comment-created. Jira's `webhookEvent`
 * naming varies (`jira:issue_updated` vs `issue_updated`, underscores vs
 * hyphens), so event names are canonicalised before matching.
 *
 * Gates, in order:
 *   (a) Jira project key → catalog projectId via the configured map
 *       (`JIRA_PROJECT_MAP`); unmapped projects are filtered.
 *   (b) strict catalog opt-in (`extensions["ship-it"].enabled === true`)
 *       via the injected `forConsumer("ship-it")` view.
 *   (c) admission: the ticket carries the `ship-it` label (mode `label`),
 *       OR — comment-created only — the triggering comment mentions
 *       @ship-it (mode `mention`).
 */
export interface JiraNormalizeContext {
  /** Jira project key → catalog projectId, e.g. `{"ABC": "acme/widgets"}`. */
  readonly projectMap: Readonly<Record<string, string>>;
  /** Jira custom field id carrying acceptance criteria, e.g. `customfield_10042`. */
  readonly acceptanceFieldId?: string | undefined;
  /** ship-it's consumer-scoped catalog view (`catalog.forConsumer("ship-it")`). */
  readonly catalogView: ConsumerCatalogView;
  readonly logger: Logger;
}

const SUPPORTED_EVENTS = new Set(["issue_updated", "issue_labeled", "comment_created"]);
const MENTION_PATTERN = /@ship-?it\b/i;
const TICKET_LABEL = "ship-it";

export function normalizeJiraEvent(body: unknown, context: JiraNormalizeContext): NormalizeResult {
  if (!isObject(body)) {
    return filtered("malformed-body");
  }

  const event = canonicalJiraEventName(body["webhookEvent"]);
  if (event === undefined || !SUPPORTED_EVENTS.has(event)) {
    return filtered("unsupported-event", { webhookEvent: body["webhookEvent"] ?? null });
  }

  const issue = asObject(body["issue"]);
  const fields = asObject(issue?.["fields"]);
  const ticketKey = nonEmptyString(issue?.["key"]);
  if (fields === undefined || ticketKey === undefined) {
    return filtered("malformed-issue", { event });
  }

  // Gate (a) — Jira project key → catalog projectId via the config map.
  const jiraProjectKey =
    nonEmptyString(asObject(fields["project"])?.["key"]) ?? ticketKey.split("-")[0] ?? "";
  const projectId = context.projectMap[jiraProjectKey];
  if (projectId === undefined) {
    return filtered("unmapped-jira-project", { jiraProjectKey, ticketKey });
  }

  // Gate (b) — strict catalog opt-in.
  if (!isShipItOptedIn(context.catalogView, projectId)) {
    return filtered("not-opted-in", { projectId, ticketKey });
  }

  // Gate (c) — admission: label first, then comment mention.
  const labels = stringArray(fields["labels"]);
  const comment = asObject(body["comment"]);
  const trigger = admissionTrigger(event, labels, comment);
  if (trigger === undefined) {
    return filtered("not-admitted", { event, labels, ticketKey });
  }

  const ticketStatus = nonEmptyString(asObject(fields["status"])?.["name"]);
  const ticketSummary = nonEmptyString(fields["summary"]);
  if (ticketStatus === undefined || ticketSummary === undefined) {
    return filtered("missing-required-fields", { event, ticketKey });
  }

  const ticketDescription =
    typeof fields["description"] === "string" ? fields["description"] : undefined;
  const acceptanceCriteria = acceptanceCriteriaFrom(fields, context.acceptanceFieldId);

  const request: ShipItRequest = {
    ticketKey,
    projectId,
    ticketStatus,
    labels,
    ticketSummary,
    ...(ticketDescription !== undefined ? { ticketDescription } : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    trigger,
  };
  return { outcome: "normalized", request, endUser: jiraEndUser(body, comment, context.logger) };
}

/** Strip the optional `jira:` prefix and normalise hyphens to underscores. */
function canonicalJiraEventName(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const withoutPrefix = raw.startsWith("jira:") ? raw.slice("jira:".length) : raw;
  return withoutPrefix.replaceAll("-", "_").toLowerCase();
}

function admissionTrigger(
  event: string,
  labels: ReadonlyArray<string>,
  comment: Record<string, unknown> | undefined,
): ShipItTrigger | undefined {
  if (labels.includes(TICKET_LABEL)) {
    return { source: "jira", mode: "label" };
  }
  if (event === "comment_created") {
    const commentBody = comment?.["body"];
    if (typeof commentBody === "string" && MENTION_PATTERN.test(commentBody)) {
      return { source: "jira", mode: "mention" };
    }
  }
  return undefined;
}

/**
 * `jira:<actor accountId>` — the comment author for comment events, else
 * the webhook's top-level `user`. Falls back to `jira:unknown` (warn-
 * logged) so an unexpected Jira shape never blocks an admitted event.
 */
function jiraEndUser(
  body: Record<string, unknown>,
  comment: Record<string, unknown> | undefined,
  logger: Logger,
): string {
  const accountId =
    nonEmptyString(asObject(comment?.["author"])?.["accountId"]) ??
    nonEmptyString(asObject(body["user"])?.["accountId"]);
  if (accountId === undefined) {
    logger.warn("ship-it-normalizer: jira event carries no actor accountId; using jira:unknown");
    return "jira:unknown";
  }
  return `jira:${accountId}`;
}

/**
 * Acceptance criteria from the env-configured custom field: an array of
 * strings is taken as-is, a non-empty string becomes a single-entry array,
 * anything else (absent field, ADF document, mixed array) is omitted.
 */
function acceptanceCriteriaFrom(
  fields: Record<string, unknown>,
  acceptanceFieldId: string | undefined,
): ReadonlyArray<string> | undefined {
  if (acceptanceFieldId === undefined) return undefined;
  const raw = fields[acceptanceFieldId];
  if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string")) {
    return raw as ReadonlyArray<string>;
  }
  if (typeof raw === "string" && raw.length > 0) {
    return [raw];
  }
  return undefined;
}

function stringArray(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
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
