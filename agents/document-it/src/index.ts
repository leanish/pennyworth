export { default } from "./agent.js";
export type {
  DocumentItBreakdownPayload,
  DocumentItInitPayload,
  DocumentItPayload,
} from "./payload.js";
// The `verify-docs` skill contract — single source of truth in
// `handler.ts` (same module that builds the input and consumes the
// output, so the public types can't drift from what the handler sends).
export type {
  DocSet,
  DriftType,
  InRepoDriftFinding,
  PublishedDriftFinding,
  VerifyDocsInput,
  VerifyDocsOutput,
} from "./handler.js";
