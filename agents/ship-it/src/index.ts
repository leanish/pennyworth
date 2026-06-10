export { default } from "./agent.js";
export type {
  ShipItEnvelope,
  ShipItInitPayload,
  ShipItPayload,
  ShipItRevisitPayload,
} from "./payload.js";
// Request shape: single source of truth in `request-schema.ts` (same module
// that defines `parseShipItRequest`, so type and validator can't drift).
// The validator + error are exported for the webhook normalizer, which
// self-checks the requests it signs against this exact contract.
export type { ShipItRequest, ShipItTrigger } from "./request-schema.js";
export { parseShipItRequest, ShipItValidationError } from "./request-schema.js";
// Step registry: which lifecycle steps exist and which are released.
export { releasedSteps, SHIP_IT_STEPS, type ShipItStep } from "./steps.js";
