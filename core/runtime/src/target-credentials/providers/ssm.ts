import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { awsClientDefaults } from "../../aws-mode/client-config.js";
import { TargetCredentialsError } from "../../errors.js";
import type { SsmCredentialEntry } from "../schema.js";
import type { ResolvedEnvVar } from "./resolved-env-var.js";

/**
 * Stored-credential provider: SSM Parameter Store `SecureString` under the
 * project's convention path (validated by the schema layer). Fetched fresh
 * per run — the call is cheap and skipping a cache keeps rotation safe.
 *
 * The SDK surface is injected behind `SsmApi` for unit tests; the real
 * client honors `AWS_ENDPOINT_URL`, so LocalStack integration tests run
 * against the genuine code path.
 */
export interface SsmApi {
  getParameter(name: string): Promise<{ readonly value: string }>;
}

export interface SsmProviderOptions {
  /** Region the suite's parameters live in (the runtime's own region). */
  readonly region: string;
  /** Test hook: replace the SDK client construction. */
  readonly api?: SsmApi;
}

export class SsmProvider {
  readonly #api: SsmApi;

  constructor(options: SsmProviderOptions) {
    this.#api = options.api ?? createSdkApi(options.region);
  }

  async resolve(entry: SsmCredentialEntry): Promise<ReadonlyArray<ResolvedEnvVar>> {
    const { value } = await this.#api.getParameter(entry.parameter);
    return [{ name: entry.env, value, secret: true }];
  }
}

function createSdkApi(region: string): SsmApi {
  const client = new SSMClient({ ...awsClientDefaults(), region });
  return {
    async getParameter(name) {
      const response = await client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      const value = response.Parameter?.Value;
      if (value === undefined) {
        throw new TargetCredentialsError(
          "resolve-failed",
          `SSM GetParameter '${name}' returned no value`,
        );
      }
      return { value };
    },
  };
}
