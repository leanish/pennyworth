export { default } from "./agent.js";
export type { AtcEnvelope, AtcPayload } from "./payload.js";
// Request shape: single source of truth in `request-schema.ts` (same
// module that defines `parseAtcRequest`, so the public types can't drift
// from what the validator accepts).
export type {
  AtcRequest,
  AtcTranscriptTurn,
  AtcAttachment,
} from "./request-schema.js";
export type {
  AtcErrorKind,
  AtcTerminalFailure,
  AtcTerminalReply,
  AtcTerminalResult,
  AtcTerminalSuccess,
} from "./terminal-reply.js";
