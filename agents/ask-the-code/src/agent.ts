import { defineAgent } from "@leanish/runtime";

import { handleAtcMessage } from "./handler.js";
import type { AtcPayload } from "./payload.js";
import type { AtcTerminalReply } from "./terminal-reply.js";

/**
 * ATC's runtime entry point. The actual transformation pipeline lives in
 * `handler.ts`. See `queue-api.md`
 * §Handler transformation for the six-step contract.
 *
 * `handle` returns the terminal reply. AWS mode discards it (delivery
 * happens via `runtime.clients.sqs.sendMessage` to `envelope.replyTo`
 * inside `deliverTerminalReply`); local mode surfaces it as the
 * `run-local` invocation's Promise resolution.
 */
export default defineAgent<AtcPayload, AtcTerminalReply>({
  identifier: "atc",
  async handle(message, runtime) {
    runtime.logger.info("atc: received message", {
      requestId: message.payload.envelope.requestId,
      consumer: message.payload.envelope.consumer,
    });
    return handleAtcMessage(message, runtime);
  },
});
