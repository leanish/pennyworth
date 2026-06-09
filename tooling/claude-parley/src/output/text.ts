import type { Outcome } from "../types.js";

/** Render the human-readable stdout view: status line, final body, and continuation when present. */
export function renderText(o: Outcome): string {
  const lines: string[] = [
    `status: ${o.status}  (${o.roundsExecuted}/${o.maxRounds} rounds, agent-1=${o.first})`,
  ];
  if (o.final.agreement !== null) {
    lines.push(`agreement: ${o.final.agreement}`);
  }
  if (o.final.disagreement !== null) {
    lines.push(`disagreement: ${o.final.disagreement}`);
  }
  if (o.final.summary !== null) {
    lines.push(`summary: ${o.final.summary}`);
  }
  if (o.error !== undefined) {
    lines.push(`error: ${o.error}`);
  }
  if (o.final.result !== null) {
    lines.push("", o.final.result);
  }
  if (o.continuation !== undefined) {
    lines.push("", "Continue with:", o.continuation);
  }
  return lines.join("\n");
}
