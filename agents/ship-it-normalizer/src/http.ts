/**
 * Minimal local typings for the AWS Lambda Function URL event/response
 * shapes (payload format 2.0). Keeping these here avoids pulling
 * `@types/aws-lambda` into the dependency surface — same approach as the
 * runtime's `aws-mode/sqs-event.ts`. Only the fields the handler consumes
 * are typed; they are stable.
 *
 * Lambda lowercases incoming header names in `headers`, so lookups in this
 * package always use lowercase keys (`x-hub-signature-256`,
 * `x-github-delivery`, `x-leanish-webhook-secret`).
 */
export interface FunctionUrlEvent {
  /** Request path, e.g. `/github` or `/jira`. */
  readonly rawPath: string;
  /** Header map with lowercased names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Raw request body; base64-encoded when `isBase64Encoded` is true. */
  readonly body?: string;
  readonly isBase64Encoded: boolean;
}

export interface FunctionUrlResponse {
  readonly statusCode: number;
  /** JSON string when present. 204 responses omit it. */
  readonly body?: string;
}
