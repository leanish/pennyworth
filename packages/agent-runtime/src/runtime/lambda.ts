/**
 * `@leanish/agent-runtime/lambda` — the focused bundle a downstream agent's
 * AWS Lambda entry module imports.
 *
 * The main `@leanish/agent-runtime` entry exposes the full surface (handler
 * types, errors, testing helpers). This sub-entrypoint is the *operator-
 * facing* surface: what a Lambda cold-start needs to wire together. By
 * importing from `/lambda`, downstream modules pull a smaller dependency
 * graph for their bundle:
 *
 *   - the SQS Lambda shim (`createSqsLambdaShim`, `SqsEvent`, `SqsRecordOutcome`, …);
 *   - the runtime builder (`buildRuntime`, `BuildRuntimeOptions`);
 *   - the needs wiring helper (`wireClients`, `ClientMode`, `WireClientsArgs`);
 *   - the coding-agent runners (`ClaudeCodeRunner`, `CodexRunner`, options);
 *   - AWS-mode stores (`DynamoIdempotencyStore`, `DynamoConsumerRegistry`);
 *   - the S3-backed catalog reader (`S3Catalog`);
 *   - the local git workspace adapter (`LocalGitWorkspace`);
 *   - the shared retry config (`awsClientDefaults`);
 *   - the descriptor loader (`loadDescriptorFromFile`);
 *   - the logger constructor (`ConsoleLogger`);
 *   - the envelope-to-message normaliser (`envelopeToRuntimeMessage`).
 *
 * Handler-facing types (`Runtime`, `RuntimeMessage`, `AgentDefinition`, all
 * error classes) stay on the main entry — handlers should import there.
 * `defineAgent({...})` likewise stays on the main entry.
 */

// SQS Lambda entry shim — the canonical verify → claim → dispatch → complete loop.
export { createSqsLambdaShim, type SqsLambdaShimOptions } from "../aws-mode/sqs-lambda-shim.js";
export type {
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
  SqsRecordOutcome,
  SqsRecordStatus,
} from "../aws-mode/sqs-event.js";

// Shared AWS SDK retry config (`maxAttempts: 5`, `retryMode: "adaptive"`).
export { awsClientDefaults, type AwsClientDefaults } from "../aws-mode/client-config.js";

// Runtime construction.
export {
  buildRuntime,
  defaultRuntimeSkillsDir,
  type BuildRuntimeOptions,
} from "./build-runtime.js";

// Needs wiring — turns the descriptor's `needs:` array into a typed clients
// bag for `runtime.clients.*`.
export {
  wireClients,
  type ClientMode,
  type WireClientsArgs,
} from "../needs/wire-clients.js";

// Coding-agent runners.
export {
  ClaudeCodeRunner,
  type ClaudeCodeRunnerOptions,
  mapEffortForClaudeCli,
} from "../skill/claude-code-runner.js";
export { CodexRunner, type CodexRunnerOptions } from "../skill/codex-runner.js";
export type { CodingAgentRunner } from "../skill/runner.js";

// AWS-mode runtime-internal typed stores.
export {
  DynamoIdempotencyStore,
  type DynamoIdempotencyStoreOptions,
} from "../idempotency/dynamo.js";
export {
  DynamoConsumerRegistry,
  type DynamoConsumerRegistryOptions,
} from "../consumer-registry/dynamo.js";

// AWS-mode catalog reader.
export { S3Catalog, type S3CatalogOptions, type CatalogBundle } from "@leanish/catalogit";

// Local git workspace (Lambda uses /tmp as the workspace root).
export {
  LocalGitWorkspace,
  type LocalGitWorkspaceOptions,
} from "../working-copy/local-git-workspace.js";

// Descriptor loading.
export {
  loadDescriptorFromFile,
  parseDescriptor,
  type DescriptorPhase,
  type ParseDescriptorOptions,
} from "../descriptor/parse.js";

// Structured logger constructor.
export { ConsoleLogger, type ConsoleLoggerOptions } from "../logger/console-logger.js";

// Envelope normaliser (lambda shim consumes this; sub-export here for the
// rare ATC-side custom shim that wants to drive normalisation itself).
export {
  envelopeToRuntimeMessage,
  type AtcEnvelopeFields,
  type AtcRuntimeMessagePayload,
  type EnvelopeMappingOptions,
} from "../envelope/to-runtime-message.js";

// Consumer registry types (the SQS shim's `consumerRegistry` parameter).
export type {
  ConsumerRecord,
  ConsumerRegistry,
  ConsumerSigningKey,
} from "../consumer-registry/store.js";
