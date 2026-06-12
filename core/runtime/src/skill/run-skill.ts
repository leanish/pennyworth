import { EntrypointInvocationError, TargetCredentialsError } from "../errors.js";
import type {
  ResolvedTargetCredentials,
  TargetCredentialsResolver,
} from "../target-credentials/resolver.js";
import { targetCredentialsNeed } from "../needs/target-credentials.js";
import type { AgentDescriptor } from "../types/descriptor.js";
import type { Logger } from "../types/logger.js";
import type { RunSkillArgs } from "../types/runtime.js";

import { renderInput } from "./input-render.js";
import { extractTerminalJson } from "./output-parse.js";
import type { CodingAgentRunner } from "./runner.js";
import type { SkillLoader } from "./skill-loader.js";
import { SchemaValidator } from "./validator.js";

/**
 * Orchestration around a single `runtime.runSkill(...)` call. Per ADR-0004:
 *
 *   1. Resolve the entrypoint name against `descriptor.skills.entrypoints`;
 *      reject early if absent.
 *   2. Load the Entry-point Skill (cached) + every Support Skill.
 *   3. Validate `input` against the Entry-point Skill's `inputSchema`.
 *   4. Render `input` as YAML (deterministic key order).
 *   5. Hand off to the configured `CodingAgentRunner`.
 *   6. Extract the terminal fenced-`json` block from the response.
 *   7. Validate the parsed value against `outputSchema`.
 *   8. Return the typed result.
 */
export interface RunSkillContext {
  readonly descriptor: AgentDescriptor;
  readonly skillLoader: SkillLoader;
  readonly runnerFor: (codingAgent: string) => CodingAgentRunner;
  readonly validator: SchemaValidator;
  readonly logger: Logger;
  /**
   * Wired when the entry shim provides one (`BuildRuntimeOptions.
   * targetCredentials`). Required whenever the descriptor declares the
   * `target-credentials` need — running the coding agent without the
   * credentials its target build expects would fail confusingly later, so
   * a missing resolver fails loudly here instead (mirrors the
   * `SelfPublishNotConfiguredError` pattern).
   */
  readonly targetCredentials?: TargetCredentialsResolver;
}

export async function runSkill<TInput, TOutput>(
  ctx: RunSkillContext,
  args: RunSkillArgs<TInput>,
): Promise<TOutput> {
  const { descriptor, skillLoader, runnerFor, validator, logger } = ctx;

  if (!descriptor.skills.entrypoints.includes(args.entrypoint)) {
    logEntrypointFailure(logger, "warn", args.entrypoint, "entrypoint-not-declared");
    throw new EntrypointInvocationError(
      "entrypoint-not-declared",
      args.entrypoint,
      `entrypoint '${args.entrypoint}' is not declared under skills.entrypoints`,
    );
  }

  const entrypoint = await skillLoader.loadEntrypoint(args.entrypoint);
  const supportSkills = await Promise.all(
    descriptor.skills.support.map((name) => skillLoader.load(name)),
  );

  const inputErrors = validator.validate(entrypoint.inputSchema!, args.input);
  if (inputErrors.length > 0) {
    logEntrypointFailure(logger, "error", args.entrypoint, "input-validation-fail", {
      schemaErrors: inputErrors,
    });
    throw new EntrypointInvocationError(
      "input-validation-fail",
      args.entrypoint,
      `input failed validation against ${args.entrypoint}.inputSchema`,
      inputErrors,
    );
  }

  const renderedArguments = renderInput(args.input, entrypoint.inputSchema);
  const codingAgent = args.codingAgent ?? descriptor.codingAgent;
  const runner = runnerFor(codingAgent);
  const model = args.model ?? descriptor.model;
  const effort = args.effort ?? descriptor.effort;
  const credentials = await resolveTargetCredentials(ctx, args.workingCopies);

  const { responseText, stderrTail } = await runner.run({
    entrypoint,
    supportSkills,
    renderedArguments,
    workingCopies: args.workingCopies,
    logger,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(credentials !== undefined && Object.keys(credentials.env).length > 0
      ? { env: credentials.env, secrets: credentials.secrets }
      : {}),
  });

  let parsed: unknown;
  try {
    parsed = extractTerminalJson(responseText, args.entrypoint);
  } catch (err) {
    if (err instanceof EntrypointInvocationError) {
      if (stderrTail !== undefined) err.attachStderrTail(stderrTail);
      logEntrypointFailure(logger, "error", args.entrypoint, err.reason, {
        captured: err.captured,
      });
    }
    throw err;
  }

  const outputErrors = validator.validate(entrypoint.outputSchema!, parsed);
  if (outputErrors.length > 0) {
    logEntrypointFailure(logger, "error", args.entrypoint, "output-validation-fail", {
      schemaErrors: outputErrors,
    });
    throw new EntrypointInvocationError(
      "output-validation-fail",
      args.entrypoint,
      `entrypoint '${args.entrypoint}' returned a JSON block that failed outputSchema validation`,
      outputErrors,
      { jsonBlock: JSON.stringify(parsed) },
    );
  }

  return parsed as TOutput;
}

/**
 * Resolve per-target-project credentials for this invocation's working
 * copies — only when the descriptor declares the `target-credentials`
 * need. Declared-but-unwired is a deploy-time misconfiguration and throws.
 */
async function resolveTargetCredentials(
  ctx: RunSkillContext,
  workingCopies: RunSkillArgs<unknown>["workingCopies"],
): Promise<ResolvedTargetCredentials | undefined> {
  if (!ctx.descriptor.needs.includes(targetCredentialsNeed.name)) return undefined;
  if (ctx.targetCredentials === undefined) {
    throw new TargetCredentialsError(
      "not-configured",
      `agent '${ctx.descriptor.identifier}' declares the '${targetCredentialsNeed.name}' need but no ` +
        `TargetCredentialsResolver is configured (BuildRuntimeOptions.targetCredentials). ` +
        `Wire createTargetCredentialsResolver(...) in the entry shim.`,
    );
  }
  return ctx.targetCredentials.resolveFor(workingCopies.map((wc) => wc.projectId));
}

function logEntrypointFailure(
  logger: Logger,
  level: "warn" | "error",
  entrypoint: string,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  const fields = { entrypoint, reason, ...extra };
  if (level === "warn") {
    logger.warn("runSkill failed", fields);
  } else {
    logger.error("runSkill failed", fields);
  }
}
