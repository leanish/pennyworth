/**
 * Where the message came from. Orthogonal to `stage` (see ADR-0012).
 *
 * Phase 1 accepts only `consumer`. Other variants are typed here so that
 * messages produced under phase-2+ are round-trippable through the parser
 * even before the runtime knows how to dispatch them — adding handler-side
 * support is additive without changing the wire shape.
 */
export const SOURCE_TRIGGERS = [
  "consumer",
  "scheduler",
  "self",
  "gh-webhook",
  "jira-webhook",
  "alert",
  "manual",
] as const;

export type SourceTrigger = (typeof SOURCE_TRIGGERS)[number];

export function isSourceTrigger(value: unknown): value is SourceTrigger {
  return (
    typeof value === "string" && (SOURCE_TRIGGERS as readonly string[]).includes(value)
  );
}
