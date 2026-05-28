import { UnhandledStageError } from "../errors.js";
import { withCorrelation } from "../logger/correlation.js";
import type { AgentDefinition } from "../types/agent.js";
import type { AgentDescriptor } from "../types/descriptor.js";
import type { AgentPayloadBase } from "../types/execution-override.js";
import type { Runtime } from "../types/runtime.js";
import type { RuntimeMessage } from "../types/runtime-message.js";
import { isStage } from "../types/stage.js";

/**
 * The canonical runtime-side checks that wrap every handler invocation.
 * Pure — no envelope verification (that's the SQS adapter's job, before
 * the message is even shaped into a `RuntimeMessage`), no idempotency
 * (that's the AWS-mode Lambda entry shim's job; local mode is exempt
 * per ADR-0006).
 *
 * Responsibilities:
 *   1. Reject messages whose `stage` isn't in the descriptor's `stages:` set.
 *   2. Call `agent.handle(message, runtime)` inside an async-local
 *      correlation scope and **return its value**. AWS-mode entry shims
 *      discard the value (delivery is via `runtime.clients.*`); local-mode
 *      `run-local` surfaces it to the caller (matches the spec's
 *      "terminal reply via Promise resolution" rule).
 *
 * Errors propagate to the caller. The Lambda shim catches them to mark
 * idempotency `claimUntil = now` and report `batchItemFailures`; `run-local`
 * lets them surface as Promise rejections.
 */
export async function dispatch<P extends AgentPayloadBase, R>(
  agent: AgentDefinition<P, R>,
  descriptor: AgentDescriptor,
  runtime: Runtime,
  message: RuntimeMessage<P>,
): Promise<R> {
  // Reject a stage that isn't in the canonical vocabulary *or* isn't in this
  // descriptor's declared `stages:` set — both are the same rejection.
  if (!isStage(message.stage) || !descriptor.stages.includes(message.stage)) {
    throw new UnhandledStageError(
      String(message.stage),
      descriptor.stages,
      descriptor.identifier,
    );
  }
  // Open an async-local correlation scope so every log line emitted
  // during this handler invocation — by the handler, runSkill, the
  // subprocess runner, AWS clients, etc. — carries the same request /
  // source / stage fields. See `logger/correlation.ts`.
  return await withCorrelation(
    {
      requestId: message.metadata.requestId,
      sourceTrigger: message.metadata.sourceTrigger,
      stage: message.stage,
    },
    () => agent.handle(message, runtime),
  );
}
