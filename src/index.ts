/**
 * `@leanish/agent-secureit` — phase-2 placeholder.
 *
 * Phase 1 ships **types only**. There is no `defineAgent({...})` here yet:
 * the handler depends on `runtime.publish` / `runtime.publishDelayed`,
 * which are deliberately absent from the phase-1 `Runtime` interface (see
 * ADR-0011). Phase 2 adds the handler in `src/agent.ts` and re-exports
 * its default export from this file.
 *
 * What this package provides today:
 *   - The locked per-stage payload contracts (`SecureitInitPayload`,
 *     `SecureitBreakdownPayload`, `SecureitRevisitPayload`).
 *   - The `agent.yaml` descriptor in the phase-2 shape (scheduler trigger,
 *     three stages, two skill entrypoints, `github` need).
 *
 * Importing anything other than the types below is a phase-2 capability;
 * downstream tooling that needs a typed handler reference should wait.
 */
export type {
  SecureitBreakdownPayload,
  SecureitInitPayload,
  SecureitPayload,
  SecureitRevisitPayload,
} from "./payload.js";
