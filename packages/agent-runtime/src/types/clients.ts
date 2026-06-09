/**
 * Typed-clients bag injected on `runtime.clients`. Each property is present
 * iff the agent's descriptor declared the matching entry under `needs:`
 * (per ADR-0010). Undeclared clients are absent at runtime; accessing them
 * throws `MissingNeedError`.
 *
 * Phase 1 ships the placeholder shapes here. AWS-mode wiring (Octokit-backed
 * GitHub client, AWS SDK v3 EventBridge / SQS clients, etc.) is brought up
 * by `runtime/build.ts` once the corresponding need spec lands.
 */

// Phase-1 placeholder typings. Each is intentionally narrow — only the
// surface the runtime / agents call today. Real impls will grow these.

export interface GitHubClient {
  /** Placeholder — full Octokit surface arrives with the github need impl. */
  readonly kind: "github";
}

export interface JiraClient {
  readonly kind: "jira";
}

export interface SlackClient {
  readonly kind: "slack";
}

export interface EventBridgeClient {
  putEvents(args: PutEventsRequest): Promise<PutEventsResult>;
}

export interface PutEventsRequest {
  readonly entries: ReadonlyArray<EventBridgeEntry>;
}

export interface EventBridgeEntry {
  readonly source: string;
  readonly detailType: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly resources?: ReadonlyArray<string>;
}

export interface PutEventsResult {
  readonly failedCount: number;
}

export interface SqsClient {
  sendMessage(args: SendMessageRequest): Promise<SendMessageResult>;
}

export interface SendMessageRequest {
  /** Either `queueUrl` or `queueArn`; queueArn is converted internally. */
  readonly queueUrl?: string;
  readonly queueArn?: string;
  readonly body: string;
  readonly delaySeconds?: number;
}

export interface SendMessageResult {
  readonly messageId: string;
}

export interface S3Client {
  getObject(args: GetObjectRequest): Promise<GetObjectResult>;
}

export interface GetObjectRequest {
  readonly bucket: string;
  readonly key: string;
}

export interface GetObjectResult {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly contentLength?: number;
}

/**
 * The shape exposed at `runtime.clients`. All fields optional; only present
 * keys come from declared `needs:`.
 */
export interface Clients {
  readonly github?: GitHubClient;
  readonly jira?: JiraClient;
  readonly slack?: SlackClient;
  readonly eventbridge?: EventBridgeClient;
  readonly sqs?: SqsClient;
  readonly s3?: S3Client;
}
