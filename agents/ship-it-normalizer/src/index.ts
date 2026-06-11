// Composition root + public seams. The Lambda entry lives behind the
// `./lambda` subpath export (it constructs AWS SDK clients on import-time
// wiring; keep it out of the default import graph).
export { createNormalizerHandler } from "./handler.js";
export type { NormalizerHandler, NormalizerHandlerOptions } from "./handler.js";
export type { FunctionUrlEvent, FunctionUrlResponse } from "./http.js";

// Envelope contract.
export {
  buildSignedEnvelope,
  NORMALIZER_CONSUMER_ID,
  SHIP_IT_EVENT_KIND,
  type BuildSignedEnvelopeArgs,
} from "./envelope.js";

// Normalizers (exported for focused tests and future reuse).
export { normalizeGitHubEvent, PR_READY_FOR_REVIEW_STATUS } from "./normalize-github.js";
export type { GitHubNormalizeContext } from "./normalize-github.js";
export { normalizeJiraEvent } from "./normalize-jira.js";
export type { JiraNormalizeContext } from "./normalize-jira.js";
export type { NormalizeResult } from "./normalize-result.js";

// Dedupe seam.
export {
  dedupeKey,
  githubDeliveryId,
  InMemoryTtlDedupeStore,
  jiraDeliveryId,
  type DedupeStore,
  type InMemoryTtlDedupeStoreOptions,
} from "./dedupe.js";

// Outbound seam.
export { SqsEnvelopeSender } from "./sender.js";
export type { EnvelopeSender, SqsEnvelopeSenderOptions, SqsSendClient } from "./sender.js";
