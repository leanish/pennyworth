/**
 * Canonical AWS SDK v3 client config the runtime layers on top of every
 * AWS client it constructs internally. Two knobs:
 *
 *   - `maxAttempts: 5`        — the SDK default is 3; we bump to 5 to absorb
 *                              short throughput spikes on Dynamo / SQS without
 *                              forwarding `batchItemFailures` for every
 *                              transient `ProvisionedThroughputExceededException`.
 *   - `retryMode: "adaptive"` — opt in to the rate-limited retry backoff
 *                              (token bucket per region+service) instead of
 *                              the default `"standard"` mode. Adaptive is the
 *                              right default for Lambda-driven workloads
 *                              that share quota across many concurrent
 *                              invocations.
 *
 * Other client config (region, credentials, endpoint, custom logger) stays
 * the caller's responsibility — `awsClientDefaults()` only contributes the
 * retry knobs and merges cleanly via spread:
 *
 *   new DynamoDBClient({ ...awsClientDefaults(), region });
 */
export interface AwsClientDefaults {
  readonly maxAttempts: number;
  readonly retryMode: "standard" | "adaptive";
}

export function awsClientDefaults(): AwsClientDefaults {
  return {
    maxAttempts: 5,
    retryMode: "adaptive",
  };
}
