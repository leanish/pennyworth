import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CatalogReadOnly, Project } from "@leanish/catalog-it";

import {
  RouterNotConfiguredError,
  SelfPublishNotConfiguredError,
  TargetCredentialsError,
} from "../errors.js";
import type { SelfPublisher } from "../self-publish/self-publisher.js";
import { gateClientsByNeeds } from "../needs/wire-clients.js";
import { createExecutionHelper } from "../execution/resolve.js";
import { ConsoleLogger } from "../logger/console-logger.js";
import { SchemaValidator } from "../skill/validator.js";
import { runSkill } from "../skill/run-skill.js";
import { SkillLoader } from "../skill/skill-loader.js";
import { validateSkillsCompatibility } from "../skill/validate-compat.js";
import type { CodingAgentRunner } from "../skill/runner.js";
import type { TargetCredentialsResolver } from "../target-credentials/resolver.js";
import type { AgentDescriptor } from "../types/descriptor.js";
import type { Clients } from "../types/clients.js";
import type { Logger } from "../types/logger.js";
import type {
  RouteProjectsArgs,
  RunSkillArgs,
  Runtime,
} from "../types/runtime.js";
import type { SyncResult } from "../types/working-copy.js";
import type { Workspace } from "../working-copy/workspace.js";

/**
 * Wire the `Runtime` object the handler will receive from concrete
 * implementations of each surface. The same builder is used by the
 * Lambda entry shim (AWS-mode adapters) and `run-local` (local-mode
 * adapters) — the only difference is which implementations get passed in.
 *
 * Returns a Promise because the builder runs the schema-subset
 * compatibility gate (`validateSkillsCompatibility`) before returning.
 * Every declared skill must accept the configured `codingAgent` or the
 * builder throws `DescriptorValidationError`. Performing the check here
 * (not in the CLI wrapper) is what makes a custom entry shim — a
 * downstream Lambda module that doesn't go through `run-local-cli` —
 * pick up the same startup-time validation as the CLI gets.
 *
 * Callers that want to skip the compat gate (e.g. tests against a stub
 * skills tree they know is incompatible) pass `{ skipCompatCheck: true }`.
 */
export interface BuildRuntimeOptions {
  readonly descriptor: AgentDescriptor;
  readonly catalog: CatalogReadOnly;
  readonly workspace: Workspace;
  /** Map of `codingAgent` identifier → runner. Phase 1: `claude-code`, `codex`. */
  readonly runners: ReadonlyMap<string, CodingAgentRunner>;
  /** Resolved per-need clients (already gated by `descriptor.needs`). */
  readonly clients: Clients;
  /** Optional. If absent, defaults to a `ConsoleLogger` bound with the agent identifier. */
  readonly logger?: Logger;
  /**
   * Optional. Precedence-ordered list of directories to search for
   * `<name>/SKILL.md`. Earlier entries win — agents pass
   * `[<agent-pkg>/skills, <runtime-pkg>/skills]` so agent-specific
   * entry-point skills (e.g. ATC's `ask`) live with the agent and the
   * runtime's bundled directory is the fallback for shared support
   * skills (`karpathy-guidelines`, etc.). Defaults to
   * `[<runtime-pkg-root>/skills]` (runtime-only — useful for tests
   * that don't ship their own skills).
   */
  readonly skillsDirs?: ReadonlyArray<string>;
  /**
   * Optional. Task-routing implementation. The runtime ships no default
   * router today; `routeProjects` throws clearly when called without one.
   */
  readonly routeProjects?: (args: RouteProjectsArgs) => Promise<ReadonlyArray<Project>>;
  /**
   * Optional. When `true`, skip the schema-subset compatibility gate that
   * normally runs before the builder returns. Tests against synthetic
   * skill fixtures may opt out; production code should not.
   */
  readonly skipCompatCheck?: boolean;
  /**
   * Optional. Backs `runtime.publish` / `runtime.publishDelayed`
   * (phase-2, ADR-0011). AWS entry shims pass `createAwsSelfPublisher`;
   * local mode and tests pass `createLocalSelfPublisher`. When absent,
   * calling either method throws `SelfPublishNotConfiguredError`.
   */
  readonly selfPublisher?: SelfPublisher;
  /**
   * Required iff the descriptor declares the `target-credentials` need:
   * resolves per-target-project credentials (`extensions.credentials`) at
   * each `runSkill`. The builder fails at startup on either mismatch
   * (declared-but-unwired, wired-but-undeclared) — a misconfigured
   * deployment must not consume messages. Entry shims pass
   * `createTargetCredentialsResolver(...)` conditionally on the need.
   */
  readonly targetCredentials?: TargetCredentialsResolver;
}

export async function buildRuntime(options: BuildRuntimeOptions): Promise<Runtime> {
  const baseLogger =
    options.logger ?? new ConsoleLogger().with({ agent: options.descriptor.identifier });
  const skillLoader = new SkillLoader({
    skillsDirs: options.skillsDirs ?? [defaultRuntimeSkillsDir()],
  });
  const validator = new SchemaValidator();
  const knownCodingAgents = new Set(options.runners.keys());
  const execution = createExecutionHelper(options.descriptor, { knownCodingAgents });

  // Startup-time compat gate: every declared skill must accept the
  // configured codingAgent. See `validateSkillsCompatibility` for the
  // exact issue categories surfaced.
  if (options.skipCompatCheck !== true) {
    await validateSkillsCompatibility(options.descriptor, skillLoader);
  }

  // Startup-time target-credentials gate: both mismatch directions are
  // deploy-time misconfigurations and must fail before any message is
  // consumed (`runSkill` keeps its own guard as defence-in-depth).
  const declaresTargetCredentials = options.descriptor.needs.includes("target-credentials");
  if (declaresTargetCredentials && options.targetCredentials === undefined) {
    throw new TargetCredentialsError(
      "not-configured",
      `agent '${options.descriptor.identifier}' declares the 'target-credentials' need but ` +
        `BuildRuntimeOptions.targetCredentials is not wired — pass createTargetCredentialsResolver(...).`,
    );
  }
  if (!declaresTargetCredentials && options.targetCredentials !== undefined) {
    throw new TargetCredentialsError(
      "not-configured",
      `agent '${options.descriptor.identifier}' wires BuildRuntimeOptions.targetCredentials but ` +
        `does not declare the 'target-credentials' need — declare it in agent.yaml or drop the resolver.`,
    );
  }

  const runnerFor = (codingAgent: string): CodingAgentRunner => {
    const runner = options.runners.get(codingAgent);
    if (runner === undefined) {
      throw new Error(
        `no CodingAgentRunner registered for codingAgent='${codingAgent}'; known: [${[...knownCodingAgents].join(", ")}]`,
      );
    }
    return runner;
  };

  return {
    // Narrow the catalog surface to `forConsumer(...)` only — agents must
    // not see the unscoped `list()` / `get()` (per `RuntimeCatalog` doc).
    catalog: { forConsumer: (id) => options.catalog.forConsumer(id) },
    async routeProjects(args) {
      if (options.routeProjects === undefined) {
        throw new RouterNotConfiguredError();
      }
      return options.routeProjects(args);
    },
    async syncWorkingCopies(projects: ReadonlyArray<Project>): Promise<SyncResult> {
      return options.workspace.sync(projects);
    },
    execution,
    async runSkill<TInput, TOutput>(args: RunSkillArgs<TInput>): Promise<TOutput> {
      return runSkill<TInput, TOutput>(
        {
          descriptor: options.descriptor,
          skillLoader,
          runnerFor,
          validator,
          logger: baseLogger,
          ...(options.targetCredentials !== undefined
            ? { targetCredentials: options.targetCredentials }
            : {}),
        },
        args,
      );
    },
    async publish(args) {
      if (options.selfPublisher === undefined) {
        throw new SelfPublishNotConfiguredError(options.descriptor.identifier);
      }
      return options.selfPublisher.publish(args);
    },
    async publishDelayed(args) {
      if (options.selfPublisher === undefined) {
        throw new SelfPublishNotConfiguredError(options.descriptor.identifier);
      }
      return options.selfPublisher.publishDelayed(args);
    },
    clients: gateClientsByNeeds(options.descriptor.needs, options.clients),
    logger: baseLogger,
  };
}

/**
 * The runtime's own bundled skills directory. Carries genuinely shared
 * support skills (e.g. `karpathy-guidelines`) that every agent inherits
 * unless it shadows them by name. Per-agent entry-point skills (`ask`,
 * `bumpit-review-alert`, …) live in the agent's own package and take
 * precedence — see `SkillLoaderOptions.skillsDirs` for the multi-dir
 * search shape and ADR-0001 for the ownership decision.
 */
function defaultRuntimeSkillsDir(): string {
  // Skills bundled inside this package live at <pkg-root>/skills/. Both
  // src/runtime/build-runtime.ts (source) and dist/runtime/build-runtime.js
  // (compiled) sit two levels deep from the package root.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
}

/** Visible for ATC + future agents constructing their own runtime. */
export { defaultRuntimeSkillsDir };
