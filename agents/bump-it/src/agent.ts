import { defineAgent } from "@leanish/runtime";

import { handleBumpItMessage } from "./handler.js";
import type { BumpItPayload } from "./payload.js";

/**
 * bump-it's runtime entry point. The per-stage orchestration lives in
 * `handler.ts`; this module only logs the delivery and dispatches.
 *
 * The handler returns `void` — bump-it has no terminal reply channel.
 * Its outputs are GitHub side effects (draft PRs, flips, rollbacks)
 * performed inside the skills, plus the self-published follow-up
 * messages.
 */
export default defineAgent<BumpItPayload, void>({
  identifier: "bump-it",
  async handle(message, runtime) {
    runtime.logger.info("bump-it: received message", {
      stage: message.stage,
      sourceTrigger: message.metadata.sourceTrigger,
    });
    return handleBumpItMessage(message, runtime);
  },
});
