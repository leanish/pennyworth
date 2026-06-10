import { defineAgent } from "@leanish/runtime";

import { handleTriageMessage } from "./handler.js";
import type { TriagePayload } from "./payload.js";
import type { TriageTerminalReply } from "./terminal-reply.js";

/**
 * triage-it's runtime entry point. The actual transformation pipeline
 * lives in `handler.ts`.
 *
 * `handle` returns the terminal reply. AWS mode discards it (delivery
 * happens via `runtime.clients.sqs.sendMessage` to `envelope.replyTo`
 * inside `deliverTerminalReply`); local mode surfaces it as the
 * `run-local` invocation's Promise resolution.
 */
export default defineAgent<TriagePayload, TriageTerminalReply>({
  identifier: "triage-it",
  async handle(message, runtime) {
    runtime.logger.info("triage-it: received message", {
      requestId: message.payload.envelope.requestId,
      consumer: message.payload.envelope.consumer,
    });
    return handleTriageMessage(message, runtime);
  },
});
