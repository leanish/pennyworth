import { ExecutionResolveError } from "../errors.js";
import type { AgentDescriptor } from "../types/descriptor.js";
import { EFFORTS, type Effort, type ExecutionOverride, type ResolvedExecution } from "../types/execution-override.js";
import type { ExecutionHelper } from "../types/runtime.js";

/**
 * Resolution order (highest to lowest), per ADR-0003 + ADR-0004:
 *   1. Per-call `runSkill(...)` arguments (applied by `runSkill` itself).
 *   2. Payload-driven `execution` override resolved here.
 *   3. Descriptor defaults.
 *
 * This helper handles layer 2 only — merging the payload override with
 * descriptor defaults and validating that explicit values are well-formed.
 * Invalid explicit overrides throw `ExecutionResolveError` (no silent drop).
 */
export interface ExecutionResolverOptions {
  /**
   * Closed set of coding-agent identifiers the runtime knows about.
   * `{ "claude-code", "codex" }` in phase 1.
   */
  readonly knownCodingAgents: ReadonlySet<string>;
  /**
   * Optional compatibility check applied to an explicit `codingAgent` override.
   * The descriptor-loader already validates static compatibility against
   * declared skills; this is for any dynamic checks the runtime layers in.
   */
  readonly isCompatible?: (codingAgent: string) => boolean;
}

export function createExecutionHelper(
  descriptor: AgentDescriptor,
  options: ExecutionResolverOptions,
): ExecutionHelper {
  return {
    resolve(override: ExecutionOverride | undefined): ResolvedExecution {
      const codingAgent = resolveCodingAgent(descriptor, override, options);
      const model = override?.model ?? descriptor.model;
      const effort = resolveEffort(descriptor, override);
      if (effort !== undefined) {
        return { codingAgent, model, effort };
      }
      return { codingAgent, model };
    },
  };
}

function resolveCodingAgent(
  descriptor: AgentDescriptor,
  override: ExecutionOverride | undefined,
  options: ExecutionResolverOptions,
): string {
  if (override?.codingAgent === undefined) return descriptor.codingAgent;
  const explicit = override.codingAgent;
  if (!options.knownCodingAgents.has(explicit)) {
    throw new ExecutionResolveError(
      "unknown-coding-agent",
      `coding agent '${explicit}' is not known to the runtime; known: [${[...options.knownCodingAgents].join(", ")}]`,
    );
  }
  if (options.isCompatible && !options.isCompatible(explicit)) {
    throw new ExecutionResolveError(
      "incompatible-coding-agent",
      `coding agent '${explicit}' is incompatible with this agent's declared skills`,
    );
  }
  return explicit;
}

function resolveEffort(
  descriptor: AgentDescriptor,
  override: ExecutionOverride | undefined,
): Effort | undefined {
  if (override?.effort === undefined) return descriptor.effort;
  const value = override.effort;
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new ExecutionResolveError(
      "invalid-effort",
      `effort '${value}' is not one of: [${EFFORTS.join(", ")}]`,
    );
  }
  return value;
}
