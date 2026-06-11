import { SendMessageCommand } from "@aws-sdk/client-sqs";

import type { SignedEnvelope } from "@leanish/runtime";

/** Outbound seam: where signed envelopes go. Tests inject a capturing fake. */
export interface EnvelopeSender {
  send(envelope: SignedEnvelope): Promise<void>;
}

/**
 * The slice of `SQSClient` the sender needs — injectable so tests capture
 * sends without an AWS endpoint.
 */
export interface SqsSendClient {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface SqsEnvelopeSenderOptions {
  /** ship-it's input queue URL (`SHIP_IT_QUEUE_URL`). */
  readonly queueUrl: string;
  readonly client: SqsSendClient;
}

/** SQS `SendMessage` of the JSON-serialised envelope to ship-it's queue. */
export class SqsEnvelopeSender implements EnvelopeSender {
  readonly #queueUrl: string;
  readonly #client: SqsSendClient;

  constructor(options: SqsEnvelopeSenderOptions) {
    this.#queueUrl = options.queueUrl;
    this.#client = options.client;
  }

  async send(envelope: SignedEnvelope): Promise<void> {
    await this.#client.send(
      new SendMessageCommand({
        QueueUrl: this.#queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );
  }
}
