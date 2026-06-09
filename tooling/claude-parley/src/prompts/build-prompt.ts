// All prompt text parley adds on top of the user's prompt-1 / prompt-2. Verdict status semantics
// live in the schema field descriptions (verdict-schema.ts), so these stay close to the user's words.

function leadIntro(resumed: boolean, prompt1: string): string {
  // On a resumed session the original task is in context, so prompt-1 is fresh guidance.
  return resumed ? `New guidance from the human: ${prompt1}` : prompt1;
}

function reviewBridge(siblingBody: string): string {
  return `Your sibling agent says ${siblingBody}; please agree, expand it or correct it`;
}

/**
 * agent-1 — the read-only reviewer/planner. Opener gets prompt-1 (or an action-mode framing that
 * asks for a textual plan); later turns react to the sibling's latest.
 */
export function reviewerPrompt(args: {
  readonly prompt1: string;
  readonly prompt2: string | undefined;
  readonly resumed: boolean;
  readonly siblingBody: string | undefined;
}): string {
  const acting = args.prompt2 !== undefined;
  if (args.siblingBody === undefined) {
    // opening turn
    return acting
      ? `The user says "${args.prompt1}", please check it and tell me in textual form how you'd deal with it`
      : leadIntro(args.resumed, args.prompt1);
  }
  // later turns: in action mode agent-1 just reviews the actor's work; in read-only it converges.
  return acting ? `Your sibling agent says ${args.siblingBody}` : reviewBridge(args.siblingBody);
}

/**
 * agent-2 — the actor (action mode) or the second reviewer (read-only). In action mode it restates
 * prompt-1 + prompt-2 every turn and acts on the agreed parts; in read-only it converges like agent-1.
 */
export function actorPrompt(args: {
  readonly prompt1: string;
  readonly prompt2: string | undefined;
  readonly resumed: boolean;
  readonly siblingBody: string;
  readonly firstTurn: boolean;
}): string {
  if (args.prompt2 !== undefined) {
    return (
      `The user says "${args.prompt1}"; your sibling agent says ${args.siblingBody}, ` +
      `please ${args.prompt2} on the parts you agree, but also try to expand it or correct it if needed`
    );
  }
  if (args.firstTurn) {
    return `${leadIntro(args.resumed, args.prompt1)}. ${reviewBridge(args.siblingBody)}`;
  }
  return reviewBridge(args.siblingBody);
}

/** Closing turn on agent-2 (read-only): consolidate the agreed outcome into the deliverable. */
export function synthesisPrompt(acting: boolean): string {
  return acting
    ? "Ok, the deliberation is done. Read-only, report what you changed, what you deliberately did not change, and any residual caveats."
    : "Ok, the deliberation is done. Put the converged result together into a single consolidated answer.";
}
