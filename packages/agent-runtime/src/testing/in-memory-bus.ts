import type {
  EventBridgeClient,
  EventBridgeEntry,
  PutEventsRequest,
  PutEventsResult,
  SendMessageRequest,
  SendMessageResult,
  SqsClient,
} from "../types/clients.js";

/**
 * In-memory `EventBridgeClient` fake for tests. Captures every entry passed
 * to `putEvents(...)` so assertions can read them back.
 *
 *   const eventbridge = new InMemoryEventBus();
 *   await runtime.clients.eventbridge?.putEvents(...);
 *   expect(eventbridge.entries).toHaveLength(1);
 *
 * Differences from the production AWS-mode client:
 *   - `failedCount` is always `0` (no failure injection).
 *   - Entries are stored in arrival order; reset with `.clear()`.
 *
 * Live in `@leanish/agent-runtime/testing` so production builds can't
 * accidentally import it.
 */
export class InMemoryEventBus implements EventBridgeClient {
  readonly #entries: EventBridgeEntry[] = [];

  async putEvents(request: PutEventsRequest): Promise<PutEventsResult> {
    for (const entry of request.entries) {
      this.#entries.push(entry);
    }
    return { failedCount: 0 };
  }

  /** Snapshot of every `putEvents` entry, in arrival order. */
  get entries(): ReadonlyArray<EventBridgeEntry> {
    return this.#entries;
  }

  /** Drop captured entries (for re-using one bus across multiple tests). */
  clear(): void {
    this.#entries.length = 0;
  }
}

/**
 * Captured shape for `InMemorySqsBus.messages` — the request that hit the
 * fake plus a synthesised `messageId` (mirrors the AWS-mode result).
 */
export interface CapturedSqsMessage {
  readonly request: SendMessageRequest;
  readonly messageId: string;
}

/**
 * In-memory `SqsClient` fake for tests. Captures every `sendMessage`
 * request so assertions can read them back. The synthesised `messageId`
 * is monotonic per-instance so tests can correlate emissions.
 */
export class InMemorySqsBus implements SqsClient {
  readonly #messages: CapturedSqsMessage[] = [];
  #counter = 0;

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.#counter += 1;
    const messageId = `in-memory-sqs-${this.#counter}`;
    this.#messages.push({ request, messageId });
    return { messageId };
  }

  /** Snapshot of every captured `sendMessage` request, in arrival order. */
  get messages(): ReadonlyArray<CapturedSqsMessage> {
    return this.#messages;
  }

  /** Drop captured messages and reset the counter. */
  clear(): void {
    this.#messages.length = 0;
    this.#counter = 0;
  }
}
