/**
 * `@leanish/agent-runtime/testing` — in-memory fakes, fixture helpers, and
 * a synthetic skill responder, packaged so downstream agent tests can
 * compose a hermetic test scaffold without poking at the runtime's
 * internal modules.
 *
 * Anything exported here is intended for **test code only**. Production
 * builds should not import from this subpath. We don't enforce that today
 * (Node has no easy way to gate sub-entrypoints by environment); the
 * convention is contractual.
 */

// In-memory stores (replace the AWS-mode adapters for unit tests).
export { MemoryIdempotencyStore } from "../idempotency/memory.js";
export { MemoryConsumerRegistry } from "../consumer-registry/memory.js";

// In-memory catalog + workspace.
export { InMemoryCatalog, isEnabledForConsumer } from "@leanish/catalogit";
export type { Project, ProjectSource, CatalogReadOnly, ConsumerCatalogView } from "@leanish/catalogit";
export { InMemoryWorkspace, type InMemoryWorkspaceOptions } from "../working-copy/in-memory-workspace.js";

// Fake coding-agent runner — register canned responses per entrypoint, or
// provide a default synthesizer that walks the entrypoint's outputSchema.
export {
  FakeCodingAgentRunner,
  type FakeResponse,
} from "../skill/fake-runner.js";

// Skill-loader for tests that need to construct a SkillLoader against a
// fixture skills directory.
export { SkillLoader, parseSkillFile } from "../skill/skill-loader.js";

// Envelope canonicaliser — useful for tests that sign their own envelopes.
export { canonicalize } from "../envelope/canonical.js";

// In-memory EventBridge + SQS clients — let tests assert on emissions
// instead of running them through the local-mode "log and forget" path.
export {
  InMemoryEventBus,
  InMemorySqsBus,
  type CapturedSqsMessage,
} from "./in-memory-bus.js";

// LocalStack-backed integration test harness. Tests fail loud if
// LocalStack isn't reachable: `LocalStackHarness.start()` throws
// `LocalStackUnavailableError` with an actionable message so the
// acceptance gate fails instead of silently skipping.
// `isLocalStackReachable` stays exported for non-test callers (e.g. the
// `lambda-rehearsal` script's precheck).
export {
  LocalStackHarness,
  LocalStackUnavailableError,
  isLocalStackReachable,
  type LocalStackHarnessOptions,
} from "./localstack-harness.js";
