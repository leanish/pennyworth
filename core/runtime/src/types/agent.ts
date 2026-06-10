import type { RuntimeMessage } from "./runtime-message.js";
import type { AgentPayloadBase } from "./execution-override.js";
import type { Runtime } from "./runtime.js";

/**
 * The user-facing agent definition. `defineAgent(...)` returns this shape;
 * the runtime entry shims (Lambda handler, `run-local`) call `handle` per
 * `RuntimeMessage` after applying idempotency and envelope verification.
 *
 * The `R` parameter is the **handler return value**. In AWS mode the value
 * is ignored — agents deliver their outputs via `runtime.clients.*` calls
 * (terminal reply on SQS, lifecycle events on EventBridge). In local mode
 * `run-local` propagates whatever `handle` returns as the resolved
 * value of the invocation, so a developer can pipe it through a tool
 * without first parsing the structured logs.
 *
 * Phase-1 ATC returns its `AtcTerminalReply`. Agents with no meaningful
 * local-mode return value can default to `R = void`.
 */
export interface AgentDefinition<
  P extends AgentPayloadBase = AgentPayloadBase,
  R = unknown,
> {
  readonly identifier: string;
  handle(message: RuntimeMessage<P>, runtime: Runtime): Promise<R>;
}
