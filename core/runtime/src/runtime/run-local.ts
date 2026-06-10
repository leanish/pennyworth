import { dispatch } from "../dispatch/dispatch.js";
import type { AgentDefinition } from "../types/agent.js";
import type { AgentDescriptor } from "../types/descriptor.js";
import type { AgentPayloadBase } from "../types/execution-override.js";
import type { Runtime } from "../types/runtime.js";
import type { RuntimeMessage } from "../types/runtime-message.js";

/**
 * Local-mode invocation entry point. Wraps `dispatch` with the local-mode
 * idempotency exemption (ADR-0006) — no claim, no completed-marker writes,
 * just call the handler once.
 *
 * **Returns the handler's value.** The Lambda entry shim discards the
 * value (AWS-mode delivery is via `runtime.clients.*`); local-mode hands
 * it back so a caller can pipe / inspect the terminal reply without
 * parsing structured logs.
 *
 * The Lambda entry shim adds the three-state idempotency wrapper around
 * `dispatch` instead of calling this directly.
 */
export interface RunLocalOptions<
  P extends AgentPayloadBase = AgentPayloadBase,
  R = unknown,
> {
  readonly agent: AgentDefinition<P, R>;
  readonly descriptor: AgentDescriptor;
  readonly runtime: Runtime;
  readonly message: RuntimeMessage<P>;
}

export async function runLocal<P extends AgentPayloadBase, R>(
  options: RunLocalOptions<P, R>,
): Promise<R> {
  return await dispatch(
    options.agent,
    options.descriptor,
    options.runtime,
    options.message,
  );
}
