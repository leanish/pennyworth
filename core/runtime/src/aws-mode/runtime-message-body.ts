import { isStage, type Stage } from "../types/stage.js";

/**
 * Parsed form of a non-envelope SQS body: a serialised `RuntimeMessage`
 * produced by `runtime.publish` / `runtime.publishDelayed` (ADR-0011,
 * `sourceTrigger: "self"`) or by the infra-provisioned recurring schedule
 * tick (`sourceTrigger: "scheduler"`).
 *
 * These bodies are NOT signed: the agent's input queue is IAM-private to
 * the agent itself and its Scheduler role, so envelope signing — a
 * consumer-boundary control — does not apply. The shim still validates
 * shape + stage + trigger admissibility before dispatching.
 */
export interface SelfRuntimeMessageBody {
  readonly stage: Stage;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sourceTrigger: "self" | "scheduler";
}

/**
 * Shape-discriminate an already-JSON-parsed SQS body. Returns the parsed
 * self/scheduler message, or `undefined` when the body is not shaped like
 * one (the caller then falls through to the consumer-envelope path).
 */
export function parseSelfRuntimeMessageBody(raw: unknown): SelfRuntimeMessageBody | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  const metadata = candidate["metadata"];
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const sourceTrigger = (metadata as Record<string, unknown>)["sourceTrigger"];
  if (sourceTrigger !== "self" && sourceTrigger !== "scheduler") return undefined;
  if (!isStage(candidate["stage"])) return undefined;
  const payload = candidate["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  return {
    stage: candidate["stage"],
    payload: payload as Readonly<Record<string, unknown>>,
    sourceTrigger,
  };
}
