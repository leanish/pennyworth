import type { SkillInvocation } from "./runner.js";

/**
 * The slash-command prompt both coding-agent runners send: `/<entrypoint>`
 * on its own when there are no rendered arguments, else `/<entrypoint>`
 * followed by the rendered YAML. Multi-line args ride inside a single CLI
 * argument because the runners spawn the process directly — no shell parsing.
 */
export function buildSlashCommandPrompt(invocation: SkillInvocation): string {
  if (invocation.renderedArguments.length === 0) {
    return `/${invocation.entrypoint.name}`;
  }
  return `/${invocation.entrypoint.name}\n${invocation.renderedArguments}`;
}
