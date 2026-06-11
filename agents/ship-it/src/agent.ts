import { defineAgent } from "@leanish/runtime";

import { handleShipItMessage } from "./handler.js";
import type { ShipItPayload } from "./payload.js";

/**
 * ship-it's runtime entry point. The stage dispatch + gating + skill
 * orchestration live in `handler.ts`.
 *
 * `handle` returns nothing: ship-it's outputs are the side effects the
 * coding-agent subprocess performs (branch, draft PR, ticket comments) and
 * the self-scheduled revisit. There is no terminal reply channel in v1 —
 * the webhook normalizer fires and forgets.
 */
export default defineAgent<ShipItPayload, void>({
  identifier: "ship-it",
  async handle(message, runtime) {
    runtime.logger.info("ship-it: received message", { stage: message.stage });
    return handleShipItMessage(message, runtime);
  },
});
