/**
 * Minimal local typings for the AWS Lambda SQS event shape. Keeping these
 * here avoids pulling `@types/aws-lambda` into the runtime's dependency
 * surface; the fields the shim consumes are stable.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<SqsRecord>;
}

export interface SqsRecord {
  readonly messageId: string;
  readonly receiptHandle?: string;
  readonly body: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly messageAttributes?: Readonly<Record<string, unknown>>;
  readonly eventSource?: string;
  readonly eventSourceARN?: string;
  readonly awsRegion?: string;
}

/**
 * Per-record outcome from the SQS Lambda entry shim. The status enum is
 * load-bearing for observability:
 *
 *   - `handled`              — verify + dispatch + complete succeeded; SQS ACKs.
 *   - `handled-stale-complete` — handler succeeded but another worker had
 *                              already reclaimed the row by the time
 *                              `complete()` ran (ADR-0006 watchdog race);
 *                              the work itself completed, so SQS ACKs.
 *   - `duplicate-completed`  — idempotency hit, prior completion; SQS ACKs.
 *   - `duplicate-in-flight`  — idempotency hit, prior still in-flight; SQS keeps the message.
 *   - `envelope-parse-failed`— body wasn't JSON; treated as malformed, kept for DLQ via max-receive.
 *   - `envelope-rejected`    — HMAC / clock-skew / unknown consumer / allowedKinds.
 *   - `handler-failed`       — dispatch threw; claim moved to immediately-expired so the next
 *                              redelivery reclaims on the first try.
 */
export type SqsRecordStatus =
  | "handled"
  | "handled-stale-complete"
  | "duplicate-completed"
  | "duplicate-in-flight"
  | "envelope-parse-failed"
  | "envelope-rejected"
  | "handler-failed";

export interface SqsRecordOutcome {
  readonly messageId: string;
  readonly status: SqsRecordStatus;
  /** Short human-readable error message when `status` is a failure variant. */
  readonly error?: string;
}

/**
 * Return shape from the shim.
 *
 * `batchItemFailures` is the **AWS-canonical** field (the only one Lambda's
 * partial-batch handling reads — set `FunctionResponseTypes:
 * ["ReportBatchItemFailures"]` on the event-source mapping). Any record
 * whose status is `duplicate-in-flight` / `envelope-*` / `handler-failed`
 * appears here so SQS keeps the message.
 *
 * `results` is the **richer observability** view — one entry per processed
 * record, in input order. AWS Lambda ignores it; callers (tests, an
 * agent-infra-built wrapper Lambda, custom logging) read it for typed
 * status detail. Carrying both lets the shim stay drop-in-compatible with
 * `ReportBatchItemFailures` while exposing structured outcomes to
 * downstream observability without a second protocol.
 */
export interface SqsBatchResponse {
  readonly batchItemFailures: ReadonlyArray<{ readonly itemIdentifier: string }>;
  readonly results: ReadonlyArray<SqsRecordOutcome>;
}
