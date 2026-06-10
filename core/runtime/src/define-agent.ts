import type { AgentDefinition } from "./types/agent.js";
import type { AgentPayloadBase } from "./types/execution-override.js";

/**
 * Defines a runtime-driven agent. Identity wrapper today; the value lives
 * in the type — the runtime's entry shims (Lambda handler, `run-local`)
 * accept `AgentDefinition<P, R>` and call `handle(message, runtime)` per
 * delivery after the canonical runtime-side checks.
 *
 * `R` is the handler's return type (defaults to `unknown`). AWS-mode entry
 * shims discard the value; local-mode `run-local` propagates it as the
 * invocation's Promise resolution. Agents that build a structured terminal
 * reply (ATC's `AtcTerminalReply`) declare `R` explicitly so callers see
 * the typed shape.
 *
 * ```ts
 * import { defineAgent } from "@leanish/runtime";
 *
 * export default defineAgent<AskPayload, AskReply>({
 *   identifier: "reviewit",
 *   async handle(message, runtime) {
 *     // ...
 *     return reply;
 *   },
 * });
 * ```
 */
export function defineAgent<
  P extends AgentPayloadBase = AgentPayloadBase,
  R = unknown,
>(definition: AgentDefinition<P, R>): AgentDefinition<P, R> {
  return definition;
}
