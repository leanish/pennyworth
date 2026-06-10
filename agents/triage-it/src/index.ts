export { default } from "./agent.js";
export type { TriageEnvelope, TriagePayload } from "./payload.js";
// Request shape: single source of truth in `request-schema.ts` (same
// module that defines `parseTriageRequest`, so the public type can't
// drift from what the validator accepts).
export type { TriageRequest } from "./request-schema.js";
export {
  EVIDENCE_LIMITS,
  InvalidEvidenceArchiveError,
  type EvidenceLimits,
} from "./evidence.js";
export type {
  TriageCodeScope,
  TriageErrorKind,
  TriageFinding,
  TriagePriorTicket,
  TriageTerminalFailure,
  TriageTerminalReply,
  TriageTerminalResult,
  TriageTerminalSuccess,
} from "./terminal-reply.js";
