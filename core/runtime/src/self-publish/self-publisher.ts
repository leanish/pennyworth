import type { PublishArgs, PublishDelayedArgs } from "../types/runtime.js";

/**
 * Adapter behind `runtime.publish` / `runtime.publishDelayed` (phase-2,
 * ADR-0011). Implementations deliver a serialised `SelfMessageBody` to the
 * **agent's own input queue** — never another agent's (the self-publish
 * constraint).
 *
 *   - AWS mode: `createAwsSelfPublisher` (SQS SendMessage / EventBridge
 *     Scheduler one-shot).
 *   - Local + tests: `createLocalSelfPublisher` (in-process queue; the
 *     delay is informational and messages are available immediately).
 *
 * `publishDelayed` is internal runtime infrastructure, not a `needs:`
 * entry — see ADR-0011 §IAM for why.
 */
export interface SelfPublisher {
  publish(args: PublishArgs): Promise<void>;
  publishDelayed(args: PublishDelayedArgs): Promise<void>;
}
