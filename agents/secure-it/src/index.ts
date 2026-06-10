/**
 * `@leanish/secure-it` — scheduler-driven Layer-3 agent that fixes open
 * GitHub security/dependency alerts via draft PRs and shepherds them
 * through CI (flip / adapt / rollback / defer).
 *
 * Public surface:
 *   - default export — the `defineAgent({...})` definition (entry shims
 *     pass it to `createSqsLambdaShim` / `run-local`).
 *   - per-stage payload types (`InitPayload`, `BreakdownPayload`,
 *     `RevisitPayload`).
 *   - the skill I/O contracts the handler exchanges with the two
 *     entry-point skills.
 *
 * The AWS Lambda entry lives in `./lambda` (see `package.json#exports`).
 */
export { default } from "./agent.js";
export type {
  BreakdownPayload,
  InitPayload,
  RevisitPayload,
  SecureItPayload,
} from "./payload.js";
export {
  CONSUMER_ID,
  handleSecureItMessage,
  isExplicitlyOptedIn,
} from "./handler.js";
export type {
  SecureItAlert,
  SecureItAlertOutcome,
  SecureItCiConclusion,
  SecureItInput,
  SecureItOutput,
  SecureItPullRequest,
  SecureItRevisitInput,
  SecureItRevisitOutcome,
  SecureItRevisitOutput,
} from "./handler.js";
