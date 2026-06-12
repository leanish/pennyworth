export {
  CREDENTIALS_EXTENSION_KEY,
  RESERVED_ENV_NAMES,
  parseCredentialsExtension,
  type CodeArtifactCredentialEntry,
  type CodeArtifactEndpoint,
  type CredentialEntry,
  type SsmCredentialEntry,
} from "./schema.js";
export {
  TargetCredentialsResolver,
  createTargetCredentialsResolver,
  type ResolvedTargetCredentials,
  type TargetCredentialsResolverOptions,
} from "./resolver.js";
export {
  CodeArtifactProvider,
  type CodeArtifactApi,
  type CodeArtifactProviderOptions,
} from "./providers/codeartifact.js";
export { SsmProvider, type SsmApi, type SsmProviderOptions } from "./providers/ssm.js";
export type { ResolvedEnvVar } from "./providers/resolved-env-var.js";
