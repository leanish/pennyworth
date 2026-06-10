/**
 * Runtime-internal `ConsumerRegistry`. Backs the envelope-verification path
 * for `consumer` triggers whose descriptor sets `signedEnvelope: true`.
 * Agents never see this surface; the SQS adapter reads it to verify
 * inbound envelopes.
 *
 * Phase 1: a `consumerId` PRIMARY KEY record carrying the consumer's
 * signing key + the set of envelope `kind`s they're allowed to publish
 * (e.g. ATC registers consumers that may publish only `ask`). Operators
 * populate via tooling; the runtime is read-only here.
 *
 * See ADR-0007 and `queue-api.md` §Consumer registration.
 */
export interface ConsumerRecord {
  readonly consumerId: string;
  /**
   * The actual signing-key bytes (base64) or the SSM parameter name to fetch
   * from at verification time. AWS-mode reads the SSM SecureString parameter;
   * local-mode YAML inlines the key. The verifier picks the right resolution
   * based on `kind`.
   */
  readonly signingKey: ConsumerSigningKey;
  /**
   * Envelope `kind` values this consumer is allowed to publish. Phase 1
   * ATC: `["ask"]`. Note this is the wire-level envelope discriminator
   * (ATC's domain vocabulary), distinct from `RuntimeMessage.stage`.
   */
  readonly allowedKinds: ReadonlyArray<string>;
  readonly description?: string;
}

export type ConsumerSigningKey =
  | { readonly kind: "literal"; readonly base64: string }
  | { readonly kind: "ssm-parameter"; readonly name: string };

export interface ConsumerRegistry {
  get(consumerId: string): Promise<ConsumerRecord | undefined>;
  /**
   * Operator-tooling surface — not exposed on `runtime.clients.*`. Present
   * here so local-mode YAML loaders and AWS-mode bootstrap scripts share
   * one interface.
   */
  put(record: ConsumerRecord): Promise<void>;
}
