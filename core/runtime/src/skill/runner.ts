import type { Logger } from "../types/logger.js";
import type { WorkingCopy } from "../types/working-copy.js";
import type { LoadedSkill } from "./skill.js";

/**
 * Subprocess-level abstraction for invoking a coding agent. The runtime
 * picks an implementation based on `descriptor.codingAgent` (`claude-code`
 * or `codex` in phase 1).
 *
 * One implementation per coding agent CLI; phase-2+ direct-API runners
 * land as additional implementations behind the same interface.
 */
export interface CodingAgentRunner {
  readonly codingAgent: string;
  run(invocation: SkillInvocation): Promise<SkillInvocationResult>;
}

export interface SkillInvocation {
  readonly entrypoint: LoadedSkill;
  readonly supportSkills: ReadonlyArray<LoadedSkill>;
  readonly renderedArguments: string;
  readonly workingCopies: ReadonlyArray<WorkingCopy>;
  readonly model?: string;
  readonly effort?: string;
  /**
   * Structured logger threaded through from the runtime. Runners use it
   * to surface debug breadcrumbs (e.g. effort-flag plumbing the underlying
   * CLI doesn't yet support) and any diagnostic output that should ride
   * the correlation context. Populated by `runSkill`; runner unit tests
   * may inject a noop.
   */
  readonly logger?: Logger;
}

export interface SkillInvocationResult {
  /**
   * Full text the coding agent emitted on its terminal channel. The runtime
   * parses the final fenced-`json` block out of this.
   */
  readonly responseText: string;
  /** Tail of stderr when the subprocess emitted anything there. */
  readonly stderrTail?: string;
}
