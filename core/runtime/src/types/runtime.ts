import type {
  CatalogReadOnly,
  ConsumerCatalogView,
  Project,
  ProjectSource,
} from "@leanish/catalog-it";

import type { Clients } from "./clients.js";
import type { ExecutionOverride, ResolvedExecution } from "./execution-override.js";
import type { Logger } from "./logger.js";
import type { Stage } from "./stage.js";
import type { SyncResult, WorkingCopy } from "./working-copy.js";

/**
 * The injected `runtime` argument the agent's `handle(message, runtime)`
 * receives. The canonical phase-1 surface; aggregate of every helper
 * documented in `agent-runtime/specs/overview.md`.
 *
 * Notable absences (deliberate):
 *   - No `runtime.state` / `runtime.idempotency` — both are runtime-internal
 *     typed stores; see ADR-0006 + ADR-0007.
 *   - No `runtime.runAgent` escape hatch — only declarative `runSkill`
 *     in v1 (see ADR-0004).
 *   - No envelope verification API — handled inside the SQS adapter via
 *     `ConsumerRegistry` for `signedEnvelope` triggers; agents never see it.
 *
 * Phase-2 widened the surface with `publish` / `publishDelayed`
 * (ADR-0011): self-publish to the agent's **own** input queue, immediate
 * or scheduled. They are wired only when the entry shim provides a
 * `SelfPublisher` (`BuildRuntimeOptions.selfPublisher`); calling them on a
 * runtime built without one throws `SelfPublishNotConfiguredError` — so a
 * phase-1 agent that never declares fan-out stages keeps working
 * untouched, and a misconfigured phase-2 deployment fails loudly on first
 * use rather than dropping messages.
 *
 * `CatalogReadOnly`, `ConsumerCatalogView`, and `Project` are owned by
 * `@leanish/catalog-it` (per suite-0007); agent-runtime re-exports them
 * from its public surface for downstream agents.
 */
export interface Runtime {
  readonly catalog: RuntimeCatalog;
  routeProjects(args: RouteProjectsArgs): Promise<ReadonlyArray<Project>>;
  syncWorkingCopies(projects: ReadonlyArray<Project>): Promise<SyncResult>;
  readonly execution: ExecutionHelper;
  runSkill<TInput, TOutput>(args: RunSkillArgs<TInput>): Promise<TOutput>;
  /**
   * Phase-2 (ADR-0011): enqueue a `RuntimeMessage` onto the agent's own
   * input queue (`metadata.sourceTrigger: "self"`). Used for per-project
   * fan-out (`stage: "breakdown"`). Self-delivery only — no cross-agent
   * publish.
   */
  publish(args: PublishArgs): Promise<void>;
  /**
   * Phase-2 (ADR-0011): like `publish`, but delivered at
   * `now + afterSeconds` via a one-shot EventBridge schedule. Local mode
   * delivers immediately (delay is informational). Repeated calls with a
   * structurally-equal payload dedupe; there is no cancellation API in v1.
   */
  publishDelayed(args: PublishDelayedArgs): Promise<void>;
  readonly clients: Clients;
  readonly logger: Logger;
}

/**
 * The catalog surface agents see on the runtime. Deliberately a strict
 * subset of `CatalogReadOnly`: **only `forConsumer(...)`**, not
 * `list()` / `get()`.
 *
 * Per `agent-runtime/specs/overview.md`: "The `forConsumer(...)` accessor
 * is the only surface; the runtime does NOT expose an unscoped top-level
 * `catalog.list()` / `catalog.get()`." Every catalog read on the runtime
 * is consumer-scoped by construction so an agent cannot accidentally
 * process projects that haven't opted in (see also catalogit's default-on
 * `isEnabledForConsumer` rule).
 *
 * `agent-infra` and curation tooling that legitimately need unscoped
 * reads (`list`, `get`) construct the underlying `CatalogReadOnly`
 * directly (e.g. `S3Catalog.load(...)`) — they don't reach in through
 * `runtime.catalog`.
 */
export interface RuntimeCatalog {
  forConsumer(consumerId: string): ConsumerCatalogView;
}

export interface RouteProjectsArgs {
  readonly task: string;
  readonly forConsumer: string;
}

export interface ExecutionHelper {
  resolve(override: ExecutionOverride | undefined): ResolvedExecution;
}

export interface RunSkillArgs<TInput> {
  readonly entrypoint: string;
  readonly input: TInput;
  readonly workingCopies: ReadonlyArray<WorkingCopy>;
  readonly codingAgent?: string;
  readonly model?: string;
  readonly effort?: ResolvedExecution["effort"];
}

/**
 * Self-publish payload for `runtime.publish` (phase-2, ADR-0011).
 */
export interface PublishArgs {
  readonly stage: Stage;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Phase-2 delayed self-publish payload. See `PublishArgs` for the
 * phase-2 framing.
 */
export interface PublishDelayedArgs extends PublishArgs {
  readonly afterSeconds: number;
}

// Re-export the catalogit types under the runtime's namespace so existing
// agent code (`import { Project } from "@leanish/runtime"`) keeps
// working without per-agent updates.
export type { CatalogReadOnly, ConsumerCatalogView, Project, ProjectSource };
