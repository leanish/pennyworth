// Public API for `@leanish/agent-runtime`. Agent code should only need
// `defineAgent` + the types. The runtime entry shims (Lambda handler,
// `run-local`) reach into the rest via the `local`/`testing` sub-exports.

export { defineAgent } from "./define-agent.js";

// Types
export type {
  AgentDefinition,
  AgentDescriptor,
  AgentPayloadBase,
  AlertTrigger,
  CatalogReadOnly,
  Clients,
  ComputeTarget,
  ConsumerCatalogView,
  ConsumerTrigger,
  DescriptorSkills,
  Effort,
  EventBridgeClient,
  EventBridgeEntry,
  ExecutionHelper,
  ExecutionOverride,
  GetObjectRequest,
  GetObjectResult,
  GhWebhookTrigger,
  GitHubClient,
  JiraClient,
  JiraWebhookTrigger,
  LogFields,
  Logger,
  LogLevel,
  Project,
  ProjectSource,
  PublishArgs,
  PublishDelayedArgs,
  PutEventsRequest,
  PutEventsResult,
  ResolvedExecution,
  RouteProjectsArgs,
  RunSkillArgs,
  Runtime,
  RuntimeCatalog,
  RuntimeMessage,
  RuntimeMessageMetadata,
  S3Client,
  SchedulerTrigger,
  SendMessageRequest,
  SendMessageResult,
  SigningSecretRef,
  SlackClient,
  SourceTrigger,
  SqsClient,
  Stage,
  SyncOutcome,
  SyncReportEntry,
  SyncResult,
  Trigger,
  WorkingCopy,
} from "./types/index.js";

// Constants
export { STAGES, isStage } from "./types/stage.js";
export { SOURCE_TRIGGERS, isSourceTrigger } from "./types/source-trigger.js";
export { EFFORTS } from "./types/execution-override.js";

// AWS-mode entry shim — pulled into the agent's Lambda module to wire the
// canonical envelope-verify → idempotency-claim → dispatch loop.
export { createSqsLambdaShim, type SqsLambdaShimOptions } from "./aws-mode/sqs-lambda-shim.js";
export type {
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
  SqsRecordOutcome,
  SqsRecordStatus,
} from "./aws-mode/sqs-event.js";
export { awsClientDefaults, type AwsClientDefaults } from "./aws-mode/client-config.js";

// Runtime construction + coding-agent runners. Needed by any entry shim
// that wires a `Runtime` from concrete adapters (Lambda module, custom
// integration tests, etc.). The shape mirrors what `run-local` does
// internally; this is the surface AWS-mode entry shims use.
export {
  buildRuntime,
  defaultRuntimeSkillsDir,
  type BuildRuntimeOptions,
} from "./runtime/build-runtime.js";
export {
  ClaudeCodeRunner,
  type ClaudeCodeRunnerOptions,
} from "./skill/claude-code-runner.js";
export { CodexRunner, type CodexRunnerOptions } from "./skill/codex-runner.js";
export type { CodingAgentRunner } from "./skill/runner.js";

// Descriptor loading. Lambda modules call `loadDescriptorFromFile` at cold
// start to read the agent's `agent.yaml`; tests use `parseDescriptor`
// directly against a YAML string.
export {
  loadDescriptorFromFile,
  parseDescriptor,
  type DescriptorPhase,
  type ParseDescriptorOptions,
} from "./descriptor/parse.js";

// Workspaces — `LocalGitWorkspace` is the AWS-mode default (clones into
// the Lambda's `/tmp` or a configured root); `InMemoryWorkspace` is the
// test/fixture shape. Both implement the `Workspace` interface that
// `buildRuntime` consumes.
export {
  LocalGitWorkspace,
  type LocalGitWorkspaceOptions,
} from "./working-copy/local-git-workspace.js";
export {
  InMemoryWorkspace,
  type InMemoryWorkspaceOptions,
} from "./working-copy/in-memory-workspace.js";
export type { Workspace } from "./working-copy/workspace.js";

// Logger — `ConsoleLogger` is the canonical JSON-line structured logger
// (same output shape in AWS mode and local mode); Lambda entry modules
// instantiate it during cold-start init and thread it through
// `wireClients` + `buildRuntime`.
export { ConsoleLogger, type ConsoleLoggerOptions } from "./logger/console-logger.js";

// Envelope verification primitives (also re-exported for ATC's tests).
export { verifyEnvelope, type SignedEnvelope, type VerifyEnvelopeArgs } from "./envelope/verify.js";
export { canonicalize } from "./envelope/canonical.js";
export {
  envelopeToRuntimeMessage,
  type AtcEnvelopeFields,
  type AtcRuntimeMessagePayload,
  type EnvelopeMappingOptions,
} from "./envelope/to-runtime-message.js";

// Consumer registry (internal store, but the AWS-mode adapter is exported
// so agent-infra-equivalent bootstrap code can populate the table).
export {
  type ConsumerRecord,
  type ConsumerRegistry,
  type ConsumerSigningKey,
  MemoryConsumerRegistry,
  DynamoConsumerRegistry,
  type DynamoConsumerRegistryOptions,
} from "./consumer-registry/index.js";

// Idempotency stores.
export {
  type ClaimAttempt,
  type ClaimOutcome,
  type IdempotencyStore,
  type IdempotencyRecord,
  type InFlightRecord,
  type CompletedRecord,
  MemoryIdempotencyStore,
  DynamoIdempotencyStore,
  type DynamoIdempotencyStoreOptions,
} from "./idempotency/index.js";

// Catalog adapters (AWS-mode S3 + local filesystem + in-memory test).
// Owned by @leanish/catalogit per suite-0007; re-exported here so
// downstream agents have a single-package import surface.
export {
  FilesystemCatalog,
  type FilesystemCatalogOptions,
  InMemoryCatalog,
  S3Catalog,
  type S3CatalogOptions,
  type CatalogBundle,
  parseProjectYaml,
  parseBundle,
  isEnabledForConsumer,
} from "@leanish/catalogit";

// Needs registry — used by AWS-mode entry shim and the run-local CLI to
// wire `runtime.clients` from the descriptor's `needs:`.
export {
  needSpecs,
  getNeedSpec,
  wireClients,
} from "./needs/index.js";
export type {
  ClientMode,
  NeedSpec,
  NeedEnvVar,
  NeedFactoryContext,
  WireClientsArgs,
} from "./needs/index.js";

// Errors
export {
  DescriptorValidationError,
  EntrypointInvocationError,
  EntrypointSchemaError,
  EnvelopeVerificationError,
  ExecutionResolveError,
  MissingNeedError,
  PhaseUnavailableError,
  RouterNotConfiguredError,
  RuntimeError,
  UnhandledStageError,
  type DescriptorIssue,
  type DescriptorIssueCategory,
  type EntrypointInvocationCapture,
  type EntrypointInvocationReason,
  type SchemaErrorItem,
} from "./errors.js";
