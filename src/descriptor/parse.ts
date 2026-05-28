import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import {
  DescriptorValidationError,
  type DescriptorIssue,
  type DescriptorIssueCategory,
} from "../errors.js";
import { needSpecs } from "../needs/registry.js";
import { EFFORTS } from "../types/execution-override.js";
import type {
  AgentDescriptor,
  ComputeTarget,
  ConsumerTrigger,
  DescriptorSkills,
  SchedulerTrigger,
  Trigger,
} from "../types/descriptor.js";
import { STAGES, type Stage } from "../types/stage.js";

/**
 * Phase selector controls which trigger types are accepted.
 *   - phase 1: `consumer` only (ATC).
 *   - phase 2: `consumer` + `scheduler` (adds secureit / publishDelayed).
 *   - phase 3+: also accepts webhook + alert triggers.
 */
export type DescriptorPhase = "phase-1" | "phase-2" | "phase-3";

export interface ParseDescriptorOptions {
  readonly phase?: DescriptorPhase;
}

const DEFAULT_PHASE: DescriptorPhase = "phase-1";

const VALID_COMPUTE: ReadonlyArray<ComputeTarget> = ["lambda", "fargate"];
const PHASE_1_COMPUTE: ReadonlyArray<ComputeTarget> = ["lambda"];

const TOP_LEVEL_FIELDS = new Set([
  "identifier",
  "compute",
  "triggers",
  "stages",
  "codingAgent",
  "model",
  "effort",
  "skills",
  "needs",
  "extensions",
]);

const SKILLS_FIELDS = new Set(["entrypoints", "support"]);

const CONSUMER_TRIGGER_FIELDS = new Set([
  "type",
  "queueArnRef",
  "dlqArnRef",
  "signedEnvelope",
]);

const SCHEDULER_TRIGGER_FIELDS = new Set([
  "type",
  "queueArnRef",
  "dlqArnRef",
]);

export async function loadDescriptorFromFile(
  path: string,
  options: ParseDescriptorOptions = {},
): Promise<AgentDescriptor> {
  const raw = await readFile(path, "utf8");
  return parseDescriptor(raw, options);
}

export function parseDescriptor(
  source: string,
  options: ParseDescriptorOptions = {},
): AgentDescriptor {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (err) {
    throw new DescriptorValidationError("agent.yaml is not valid YAML", [
      {
        path: "",
        category: "invalid-shape",
        message: err instanceof Error ? err.message : String(err),
      },
    ]);
  }
  if (!isObject(parsed)) {
    throw new DescriptorValidationError("agent.yaml top level must be a mapping", [
      { path: "", category: "invalid-shape", message: "expected an object" },
    ]);
  }
  return validateDescriptor(parsed, options.phase ?? DEFAULT_PHASE);
}

function validateDescriptor(
  value: Record<string, unknown>,
  phase: DescriptorPhase,
): AgentDescriptor {
  const issues: DescriptorIssue[] = [];

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      issues.push({
        path: key,
        category: "unknown-field",
        message: `'${key}' is not a recognised top-level field`,
      });
    }
  }

  const identifier = requireString(value, "identifier", issues);
  const compute = requireEnum(value, "compute", VALID_COMPUTE, issues);
  const codingAgent = requireString(value, "codingAgent", issues);
  const model = requireString(value, "model", issues);
  const effort = optionalEnum(value, "effort", EFFORTS, issues);
  const stages = validateStages(value, issues);
  const skills = validateSkills(value, issues);
  const needs = validateNeeds(value, issues);
  const triggers = validateTriggers(value, phase, issues);
  const extensions = validateExtensions(value, issues);

  if (compute && phase === "phase-1" && !PHASE_1_COMPUTE.includes(compute)) {
    issues.push({
      path: "compute",
      category: "compute-phase-mismatch",
      message: `compute '${compute}' is not supported in phase-1; allowed: [${PHASE_1_COMPUTE.join(", ")}]`,
    });
  }

  if (issues.length > 0) {
    throw new DescriptorValidationError(
      `agent.yaml failed validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      issues,
    );
  }

  // Issues empty ⇒ every required field is present and well-typed.
  const descriptor: AgentDescriptor = {
    identifier: identifier!,
    compute: compute!,
    triggers: triggers!,
    stages: stages!,
    codingAgent: codingAgent!,
    model: model!,
    ...(effort !== undefined ? { effort } : {}),
    skills: skills!,
    needs,
    extensions,
  };
  return descriptor;
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  issues: DescriptorIssue[],
): string | undefined {
  const v = value[field];
  if (typeof v !== "string" || v.length === 0) {
    issues.push({
      path: field,
      category: v === undefined ? "missing-required" : "invalid-shape",
      message: `'${field}' must be a non-empty string`,
    });
    return undefined;
  }
  return v;
}

function requireEnum<T extends string>(
  value: Record<string, unknown>,
  field: string,
  allowed: ReadonlyArray<T>,
  issues: DescriptorIssue[],
): T | undefined {
  const v = value[field];
  if (v === undefined) {
    issues.push({
      path: field,
      category: "missing-required",
      message: `'${field}' is required`,
    });
    return undefined;
  }
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    issues.push({
      path: field,
      category: "invalid-enum",
      message: `'${field}' must be one of: [${allowed.join(", ")}]`,
    });
    return undefined;
  }
  return v as T;
}

function optionalEnum<T extends string>(
  value: Record<string, unknown>,
  field: string,
  allowed: ReadonlyArray<T>,
  issues: DescriptorIssue[],
): T | undefined {
  const v = value[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    issues.push({
      path: field,
      category: "invalid-enum",
      message: `'${field}' must be one of: [${allowed.join(", ")}]`,
    });
    return undefined;
  }
  return v as T;
}

function validateStages(
  value: Record<string, unknown>,
  issues: DescriptorIssue[],
): ReadonlyArray<Stage> | undefined {
  const raw = value["stages"];
  if (raw === undefined) {
    issues.push({
      path: "stages",
      category: "missing-required",
      message: "'stages' is required",
    });
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      path: "stages",
      category: "invalid-shape",
      message: "'stages' must be an array",
    });
    return undefined;
  }
  if (raw.length === 0) {
    issues.push({
      path: "stages",
      category: "empty-stages",
      message: "'stages' must be non-empty",
    });
    return undefined;
  }
  const stages: Stage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (typeof s !== "string" || !(STAGES as readonly string[]).includes(s)) {
      issues.push({
        path: `stages.${i}`,
        category: "unknown-stage",
        message: `'${String(s)}' is not in the canonical stage vocabulary [${STAGES.join(", ")}]`,
      });
      continue;
    }
    stages.push(s as Stage);
  }
  return stages;
}

function validateSkills(
  value: Record<string, unknown>,
  issues: DescriptorIssue[],
): DescriptorSkills | undefined {
  const raw = value["skills"];
  if (raw === undefined) {
    issues.push({
      path: "skills",
      category: "missing-required",
      message: "'skills' is required",
    });
    return undefined;
  }
  if (!isObject(raw)) {
    issues.push({
      path: "skills",
      category: "invalid-shape",
      message: "'skills' must be an object",
    });
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!SKILLS_FIELDS.has(key)) {
      issues.push({
        path: `skills.${key}`,
        category: "unknown-field",
        message: `'skills.${key}' is not a recognised field`,
      });
    }
  }
  const entrypoints = validateStringArray(raw, "entrypoints", "skills.", issues);
  if (entrypoints !== undefined && entrypoints.length === 0) {
    issues.push({
      path: "skills.entrypoints",
      category: "empty-entrypoints",
      message: "'skills.entrypoints' must be non-empty",
    });
  }
  const support = validateStringArray(raw, "support", "skills.", issues, true) ?? [];

  if (entrypoints === undefined) return undefined;
  return { entrypoints, support };
}

function validateStringArray(
  parent: Record<string, unknown>,
  field: string,
  pathPrefix: string,
  issues: DescriptorIssue[],
  optional = false,
): ReadonlyArray<string> | undefined {
  const raw = parent[field];
  if (raw === undefined) {
    if (!optional) {
      issues.push({
        path: `${pathPrefix}${field}`,
        category: "missing-required",
        message: `'${pathPrefix}${field}' is required`,
      });
    }
    return optional ? [] : undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      path: `${pathPrefix}${field}`,
      category: "invalid-shape",
      message: `'${pathPrefix}${field}' must be an array of strings`,
    });
    return undefined;
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string" || item.length === 0) {
      issues.push({
        path: `${pathPrefix}${field}.${i}`,
        category: "invalid-shape",
        message: `'${pathPrefix}${field}.${i}' must be a non-empty string`,
      });
      continue;
    }
    out.push(item);
  }
  return out;
}

function validateNeeds(
  value: Record<string, unknown>,
  issues: DescriptorIssue[],
): ReadonlyArray<string> {
  if (value["needs"] === undefined) return [];
  const raw = validateStringArray(value, "needs", "", issues, true) ?? [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const name = raw[i]!;
    if (!needSpecs.has(name)) {
      issues.push({
        path: `needs.${i}`,
        category: "unknown-need",
        message: `'${name}' is not in the needSpecs registry`,
      });
    }
    if (seen.has(name)) {
      issues.push({
        path: `needs.${i}`,
        category: "duplicate-need",
        message: `'${name}' is declared more than once in needs`,
      });
    }
    seen.add(name);
  }
  // Note: a *declared-but-unused* need (`needs: [eventbridge]` but the
  // handler never reaches for `runtime.clients.eventbridge`) is intentionally
  // NOT a parse-time issue. Detecting it would require static analysis of
  // the handler source, which is out of scope for phase 1. Runtime
  // telemetry (counter on per-need accesses) is the right home for that
  // signal; phase-2 candidate.
  return raw;
}

function validateExtensions(
  value: Record<string, unknown>,
  issues: DescriptorIssue[],
): Readonly<Record<string, unknown>> {
  const raw = value["extensions"];
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    issues.push({
      path: "extensions",
      category: "invalid-shape",
      message: "'extensions' must be an object",
    });
    return {};
  }
  return raw;
}

function validateTriggers(
  value: Record<string, unknown>,
  phase: DescriptorPhase,
  issues: DescriptorIssue[],
): ReadonlyArray<Trigger> | undefined {
  const raw = value["triggers"];
  if (raw === undefined) {
    issues.push({
      path: "triggers",
      category: "missing-required",
      message: "'triggers' is required",
    });
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({
      path: "triggers",
      category: "invalid-shape",
      message: "'triggers' must be a non-empty array",
    });
    return undefined;
  }
  const triggers: Trigger[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isObject(entry)) {
      issues.push({
        path: `triggers.${i}`,
        category: "invalid-shape",
        message: `'triggers.${i}' must be an object`,
      });
      continue;
    }
    const type = entry["type"];
    if (typeof type !== "string") {
      issues.push({
        path: `triggers.${i}.type`,
        category: "missing-required",
        message: `'triggers.${i}.type' is required`,
      });
      continue;
    }
    if (!isTriggerTypeInPhase(type, phase)) {
      issues.push({
        path: `triggers.${i}.type`,
        category: "unknown-or-out-of-phase-trigger",
        message: `trigger type '${type}' is not supported in ${phase}`,
      });
      continue;
    }
    if (type === "consumer") {
      const trigger = parseConsumerTrigger(entry, i, issues);
      if (trigger) triggers.push(trigger);
      continue;
    }
    if (type === "scheduler") {
      const trigger = parseSchedulerTrigger(entry, i, issues);
      if (trigger) triggers.push(trigger);
      continue;
    }
    // phase 3+ trigger types: shape validation deferred until those phases
    // are wired up. For now, accept the entry as-is via cast (already filtered
    // by isTriggerTypeInPhase above).
    triggers.push(entry as unknown as Trigger);
  }
  return triggers;
}

function isTriggerTypeInPhase(type: string, phase: DescriptorPhase): boolean {
  switch (phase) {
    case "phase-1":
      return type === "consumer";
    case "phase-2":
      return type === "consumer" || type === "scheduler";
    case "phase-3":
      return (
        type === "consumer" ||
        type === "scheduler" ||
        type === "gh-webhook" ||
        type === "jira-webhook" ||
        type === "alert"
      );
  }
}

function parseConsumerTrigger(
  entry: Record<string, unknown>,
  index: number,
  issues: DescriptorIssue[],
): ConsumerTrigger | undefined {
  const prefix = `triggers.${index}`;
  for (const key of Object.keys(entry)) {
    if (!CONSUMER_TRIGGER_FIELDS.has(key)) {
      issues.push({
        path: `${prefix}.${key}`,
        category: "unknown-field",
        message: `'${key}' is not a recognised field on a 'consumer' trigger`,
      });
    }
  }
  const queueArnRef = requireString(entry, "queueArnRef", issues);
  const dlqArnRef = requireString(entry, "dlqArnRef", issues);
  const signedEnvelopeRaw = entry["signedEnvelope"];
  let signedEnvelope = false;
  if (signedEnvelopeRaw !== undefined) {
    if (typeof signedEnvelopeRaw !== "boolean") {
      issues.push({
        path: `${prefix}.signedEnvelope`,
        category: "invalid-shape",
        message: `'${prefix}.signedEnvelope' must be a boolean`,
      });
    } else {
      signedEnvelope = signedEnvelopeRaw;
    }
  }
  if (queueArnRef === undefined || dlqArnRef === undefined) return undefined;
  return { type: "consumer", queueArnRef, dlqArnRef, signedEnvelope };
}

function parseSchedulerTrigger(
  entry: Record<string, unknown>,
  index: number,
  issues: DescriptorIssue[],
): SchedulerTrigger | undefined {
  const prefix = `triggers.${index}`;
  for (const key of Object.keys(entry)) {
    if (!SCHEDULER_TRIGGER_FIELDS.has(key)) {
      issues.push({
        path: `${prefix}.${key}`,
        category: "unknown-field",
        message: `'${key}' is not a recognised field on a 'scheduler' trigger`,
      });
    }
  }
  const queueArnRef = requireString(entry, "queueArnRef", issues);
  const dlqArnRef = requireString(entry, "dlqArnRef", issues);
  if (queueArnRef === undefined || dlqArnRef === undefined) return undefined;
  return { type: "scheduler", queueArnRef, dlqArnRef };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Re-exports for ergonomic imports outside this module.
export { type DescriptorIssue, type DescriptorIssueCategory };
