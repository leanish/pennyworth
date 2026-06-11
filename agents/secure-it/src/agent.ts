import { defineAgent } from "@leanish/runtime";

import { handleSecureItMessage } from "./handler.js";
import type { SecureItPayload } from "./payload.js";

/**
 * secure-it's runtime entry point. The per-stage orchestration lives in
 * `handler.ts`; this module only logs the delivery and dispatches.
 *
 * The handler returns `void` — secure-it has no terminal reply channel.
 * Its outputs are GitHub side effects (draft PRs, flips, rollbacks)
 * performed inside the skills, plus the self-published follow-up
 * messages.
 */
export default defineAgent<SecureItPayload, void>({
  identifier: "secure-it",
  async handle(message, runtime) {
    runtime.logger.info("secure-it: received message", {
      stage: message.stage,
      sourceTrigger: message.metadata.sourceTrigger,
    });
    return handleSecureItMessage(message, runtime);
  },
});
