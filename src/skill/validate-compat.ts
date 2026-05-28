import { DescriptorValidationError, type DescriptorIssue } from "../errors.js";
import type { AgentDescriptor } from "../types/descriptor.js";

import type { SkillLoader } from "./skill-loader.js";

/**
 * Walks the descriptor's declared entrypoints + support skills, loads each
 * one, and rejects descriptors whose `codingAgent` is excluded by any
 * declared skill's `compatibleCodingAgents` allowlist.
 *
 * Throws `DescriptorValidationError` with category `incompatible-coding-agent`
 * for the first mismatch (and any unknown-skill issues encountered along the
 * way). Per descriptor.md §Validation, this happens at runtime startup
 * before any message is consumed.
 */
export async function validateSkillsCompatibility(
  descriptor: AgentDescriptor,
  skillLoader: SkillLoader,
): Promise<void> {
  const issues: DescriptorIssue[] = [];
  const all = [
    ...descriptor.skills.entrypoints.map((name) => ({ name, role: "entrypoints" as const })),
    ...descriptor.skills.support.map((name) => ({ name, role: "support" as const })),
  ];
  for (const { name, role } of all) {
    try {
      const skill =
        role === "entrypoints"
          ? await skillLoader.loadEntrypoint(name)
          : await skillLoader.load(name);
      const allowed = skill.compatibleCodingAgents;
      if (allowed !== undefined && !allowed.includes(descriptor.codingAgent)) {
        issues.push({
          path: `skills.${role}`,
          category: "incompatible-coding-agent",
          message: `skill '${name}' is compatible with [${allowed.join(", ")}] but descriptor.codingAgent='${descriptor.codingAgent}'`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({
        path: `skills.${role}`,
        category: "unknown-skill",
        message: `failed to load skill '${name}': ${message}`,
      });
    }
  }
  if (issues.length > 0) {
    throw new DescriptorValidationError(
      `descriptor failed compatibility validation against bundled skills (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      issues,
    );
  }
}
