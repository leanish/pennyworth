import { defineAgent } from "@leanish/runtime";

import { handleDocumentItMessage } from "./handler.js";
import type { DocumentItPayload } from "./payload.js";

/**
 * document-it's runtime entry point. The stage dispatch (init fan-out /
 * breakdown audit) lives in `handler.ts`; this module only binds it to
 * `defineAgent` so both entry shims (Lambda, `run-local`) share one
 * handler.
 */
export default defineAgent<DocumentItPayload>({
  identifier: "document-it",
  async handle(message, runtime) {
    runtime.logger.info("document-it: received message", {
      stage: message.stage,
      sourceTrigger: message.metadata.sourceTrigger,
      requestId: message.metadata.requestId,
    });
    await handleDocumentItMessage(message, runtime);
  },
});
