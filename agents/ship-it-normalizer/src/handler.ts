import type { CatalogReadOnly } from "@leanish/catalog-it";
import type { Logger } from "@leanish/runtime";

import { dedupeKey, githubDeliveryId, jiraDeliveryId, type DedupeStore } from "./dedupe.js";
import { buildSignedEnvelope } from "./envelope.js";
import type { FunctionUrlEvent, FunctionUrlResponse } from "./http.js";
import { normalizeGitHubEvent } from "./normalize-github.js";
import { normalizeJiraEvent } from "./normalize-jira.js";
import { SHIP_IT_CONSUMER_ID, type NormalizeResult } from "./normalize-result.js";
import { rawRequestBody } from "./raw-body.js";
import type { EnvelopeSender } from "./sender.js";
import { GITHUB_SIGNATURE_HEADER, verifyGitHubSignature } from "./verify-github.js";
import { JIRA_SECRET_HEADER, verifyJiraSecret } from "./verify-jira.js";

/**
 * The normalizer pipeline, per request:
 *
 *   route (`/jira` | `/github`; else 404)
 *     → verify the inbound webhook signature on the RAW bytes (fail → 401)
 *     → parse JSON (fail → 400)
 *     → dedupe (already seen → 200 `{"deduped": true}`)
 *     → normalize + gate (filtered → 204 with a structured log of WHY)
 *     → build the signed `ship-it-event` envelope
 *     → send to ship-it's queue
 *     → 202.
 *
 * Anything thrown escapes to a top-level try/catch → 500 with a logged
 * error. Log lines never include secrets or signature header values.
 */
export interface NormalizerHandlerOptions {
  /** GitHub webhook HMAC secret (`GITHUB_WEBHOOK_SECRET`). */
  readonly githubWebhookSecret: string;
  /** Jira static shared secret (`JIRA_WEBHOOK_SECRET`). */
  readonly jiraWebhookSecret: string;
  /** Raw envelope-signing-key bytes (base64-decoded `ENVELOPE_SIGNING_KEY`). */
  readonly envelopeSigningKey: Buffer;
  readonly catalog: CatalogReadOnly;
  /** Jira project key → catalog projectId (`JIRA_PROJECT_MAP`). */
  readonly jiraProjectMap: Readonly<Record<string, string>>;
  /** Jira acceptance-criteria custom field id (`JIRA_ACCEPTANCE_FIELD`). */
  readonly jiraAcceptanceFieldId?: string | undefined;
  readonly dedupe: DedupeStore;
  readonly sender: EnvelopeSender;
  readonly logger: Logger;
  /** Clock override for tests; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export type NormalizerHandler = (event: FunctionUrlEvent) => Promise<FunctionUrlResponse>;

type Route = "github" | "jira";

export function createNormalizerHandler(options: NormalizerHandlerOptions): NormalizerHandler {
  const now = options.now ?? (() => new Date());
  const logger = options.logger;

  return async (event: FunctionUrlEvent): Promise<FunctionUrlResponse> => {
    try {
      const route = routeOf(event.rawPath);
      if (route === undefined) {
        return json(404, { error: "not-found" });
      }
      const log = logger.with({ route });

      const rawBody = rawRequestBody(event);
      if (!verifySignature(route, event, rawBody, options)) {
        log.warn("ship-it-normalizer: rejected delivery — signature verification failed");
        return json(401, { error: "invalid-signature" });
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        log.warn("ship-it-normalizer: rejected delivery — body is not valid JSON");
        return json(400, { error: "invalid-json" });
      }

      const deliveryId = deliveryIdOf(route, event, body, rawBody);
      const action = actionOf(route, body);
      const key = dedupeKey(route, deliveryId, action);
      if ((await options.dedupe.claim(key)) === "duplicate") {
        log.info("ship-it-normalizer: duplicate delivery suppressed", { dedupeKey: key });
        return json(200, { deduped: true });
      }

      // From here the claim is held: any failure before the envelope is
      // actually sent must RELEASE it, so the provider's retry of the same
      // delivery id is admitted instead of being suppressed as a duplicate.
      try {
        const result = normalize(route, body, options);
        if (result.outcome === "filtered") {
          log.info("ship-it-normalizer: event filtered", {
            reason: result.reason,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
            deliveryId,
            action,
          });
          return { statusCode: 204 };
        }

        const envelope = buildSignedEnvelope({
          request: result.request,
          requestId: deliveryId,
          endUser: result.endUser,
          signingKey: options.envelopeSigningKey,
          timestamp: now().toISOString(),
        });
        await options.sender.send(envelope);
        log.info("ship-it-normalizer: envelope sent", {
          requestId: deliveryId,
          ticketKey: result.request.ticketKey,
          projectId: result.request.projectId,
          trigger: result.request.trigger ?? null,
        });
        return json(202, { accepted: true, requestId: deliveryId });
      } catch (err) {
        await options.dedupe.release(key).catch(() => {
          // Best-effort: a failed release only risks suppressing one retry
          // within the TTL; the error below is the primary signal.
        });
        throw err;
      }
    } catch (err) {
      logger.error("ship-it-normalizer: unhandled error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return json(500, { error: "internal-error" });
    }
  };
}

function routeOf(rawPath: string): Route | undefined {
  if (rawPath === "/github") return "github";
  if (rawPath === "/jira") return "jira";
  return undefined;
}

function verifySignature(
  route: Route,
  event: FunctionUrlEvent,
  rawBody: Buffer,
  options: NormalizerHandlerOptions,
): boolean {
  if (route === "github") {
    return verifyGitHubSignature(
      rawBody,
      event.headers[GITHUB_SIGNATURE_HEADER],
      options.githubWebhookSecret,
    );
  }
  return verifyJiraSecret(event.headers[JIRA_SECRET_HEADER], options.jiraWebhookSecret);
}

function deliveryIdOf(
  route: Route,
  event: FunctionUrlEvent,
  body: unknown,
  rawBody: Buffer,
): string {
  if (route === "github") {
    return githubDeliveryId(event.headers["x-github-delivery"], rawBody);
  }
  return jiraDeliveryId(body, rawBody);
}

/** The action segment of the dedupe key: GitHub's `action`, Jira's `webhookEvent`. */
function actionOf(route: Route, body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "unknown";
  const obj = body as Record<string, unknown>;
  const raw = route === "github" ? obj["action"] : obj["webhookEvent"];
  return typeof raw === "string" && raw.length > 0 ? raw : "unknown";
}

function normalize(
  route: Route,
  body: unknown,
  options: NormalizerHandlerOptions,
): NormalizeResult {
  // Snapshot-stable consumer view captured per request (S3Catalog semantics).
  const catalogView = options.catalog.forConsumer(SHIP_IT_CONSUMER_ID);
  if (route === "github") {
    return normalizeGitHubEvent(body, { catalogView, logger: options.logger });
  }
  return normalizeJiraEvent(body, {
    projectMap: options.jiraProjectMap,
    acceptanceFieldId: options.jiraAcceptanceFieldId,
    catalogView,
    logger: options.logger,
  });
}

function json(statusCode: number, body: Readonly<Record<string, unknown>>): FunctionUrlResponse {
  return { statusCode, body: JSON.stringify(body) };
}
