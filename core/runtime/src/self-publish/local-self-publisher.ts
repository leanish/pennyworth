import type { PublishArgs, PublishDelayedArgs } from "../types/runtime.js";

import { buildSelfMessageBody, type SelfMessageBody } from "./serialize.js";
import type { SelfPublisher } from "./self-publisher.js";

/**
 * Local-mode / test self-publisher (ADR-0011 §Mechanism, local mode).
 * Appends to an in-process queue the caller owns and drains. The delay on
 * `publishDelayed` is **informational only** — messages are available
 * immediately (`afterSeconds` is recorded so tests can assert on it).
 * No dedupe in local mode, by design.
 */
export interface LocalSelfPublishEntry {
  readonly body: SelfMessageBody;
  /** Present only for `publishDelayed` calls. */
  readonly afterSeconds?: number;
}

export function createLocalSelfPublisher(
  queue: LocalSelfPublishEntry[],
  clock?: () => string,
): SelfPublisher {
  return {
    async publish(args: PublishArgs): Promise<void> {
      queue.push({
        body: buildSelfMessageBody({
          stage: args.stage,
          payload: args.payload,
          ...(clock !== undefined ? { clock } : {}),
        }),
      });
    },
    async publishDelayed(args: PublishDelayedArgs): Promise<void> {
      queue.push({
        body: buildSelfMessageBody({
          stage: args.stage,
          payload: args.payload,
          ...(clock !== undefined ? { clock } : {}),
        }),
        afterSeconds: args.afterSeconds,
      });
    },
  };
}
