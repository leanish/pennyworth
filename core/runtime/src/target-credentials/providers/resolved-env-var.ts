/**
 * One env var a credential provider materialized for the coding-agent
 * subprocess. `secret: true` values are redacted from captured output
 * (via the runtime's `Redactor`); non-secret values (e.g. repository
 * endpoint URLs) pass through untouched.
 */
export interface ResolvedEnvVar {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}
