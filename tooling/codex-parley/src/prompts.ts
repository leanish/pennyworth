import type { Slot, Verdict } from "./types.js";

export type BuildPromptInput = {
  slot: Slot;
  round: number;
  prompt1: string;
  prompt2?: string;
  otherBody?: string;
  reviewerVerdict?: Verdict;
  isFirstTurnForSlot: boolean;
  isResumedSlot: boolean;
};

export function buildPrompt(input: BuildPromptInput): string {
  if (input.isFirstTurnForSlot && input.isResumedSlot) {
    return buildResumedPrompt(input);
  }

  if (input.slot === "reviewer") {
    return input.round === 1 ? buildOpeningReviewerPrompt(input.prompt1) : buildLaterReviewerPrompt(input);
  }

  return buildActorPrompt(input);
}

function buildOpeningReviewerPrompt(prompt1: string): string {
  return [
    "You are participating in `parley`, a bounded deliberation between two coding agents. You are the",
    "**read-only reviewer** — do not edit files; analyse only.",
    "",
    "Task:",
    prompt1,
    "",
    "This is the first turn; there is no prior output to react to. Produce your best analysis of the",
    "task. Set `status` = `agree` if there is nothing to address, `disagree` if there is work to",
    "address (put specifics in `body`), or `needs-user` only if a genuinely human decision blocks",
    "progress.",
  ].join("\n");
}

function buildLaterReviewerPrompt(input: BuildPromptInput): string {
  return [
    "You are the **read-only reviewer** in `parley` — do not edit files; analyse only.",
    "",
    "Original task:",
    input.prompt1,
    "",
    "The actor's latest response:",
    requiredOtherBody(input),
    "",
    "The actor may have edited the working tree — inspect it read-only. Evaluate the current state.",
    "Set `status` = `agree` if it fully addresses the task (you approve), `disagree` if issues remain",
    "(be concrete in `body`), or `needs-user` if a human decision is required. Do not invent",
    "disagreement; converge when you can.",
  ].join("\n");
}

function buildActorPrompt(input: BuildPromptInput): string {
  const lines =
    input.prompt2 === undefined
      ? [
          "You are the second reviewer in `parley`. This deliberation is **read-only** — do not edit files.",
          "",
          "Original task:",
          input.prompt1,
          "",
          "The first reviewer's latest assessment:",
          requiredOtherBody(input),
          "",
          "Agree with it, disagree (with concrete reasons), or enhance it. Set `status` accordingly; put",
          "your prose in `body`.",
        ]
      : [
          "You are the **actor** in `parley`. You may edit the working tree.",
          "",
          "Original task:",
          input.prompt1,
          "",
          "The reviewer's latest assessment:",
          requiredOtherBody(input),
          "",
          "Your action:",
          input.prompt2,
          "",
          "Carry out the action in light of the assessment, then report. Set `status` = `agree` if you have",
          "addressed the assessment and have no objection, `disagree` if you disagree with the critique",
          "(explain in `body` — do not comply blindly), or `needs-user` if a human decision is required.",
        ];

  if (input.reviewerVerdict?.status === "needs-user") {
    lines.push(
      "",
      "The reviewer raised an open question. Try to resolve it from the codebase or your own knowledge.",
      "Return `needs-user` only if a genuinely human decision still remains.",
      "",
      "Open question:",
      input.reviewerVerdict.body,
    );
  }

  return lines.join("\n");
}

function buildResumedPrompt(input: BuildPromptInput): string {
  if (input.slot === "reviewer") {
    return [
      "You are the **read-only reviewer** in `parley` — do not edit files; analyse only.",
      "",
      "New guidance from the human:",
      input.prompt1,
      "",
      "The original task and the deliberation so far are preserved in this session. Re-evaluate in light",
      "of the new guidance. Set `status` (`agree` / `disagree` / `needs-user`) as before.",
    ].join("\n");
  }

  const lines =
    input.prompt2 === undefined
      ? [
          "You are the second reviewer in `parley`. This deliberation is **read-only** — do not edit files.",
          "",
          "New guidance from the human:",
          input.prompt1,
          "",
          "The first reviewer's latest assessment from this resumed run:",
          requiredOtherBody(input),
          "",
          "The original task and the deliberation so far are preserved in this session. Re-evaluate in light",
          "of the new guidance. Agree, disagree with concrete reasons, enhance it, or return `needs-user`",
          "only if a human decision is required.",
        ]
      : [
          "You are the **actor** in `parley`. You may edit the working tree.",
          "",
          "New guidance from the human:",
          input.prompt1,
          "",
          "The reviewer's latest assessment from this resumed run:",
          requiredOtherBody(input),
          "",
          "Your action:",
          input.prompt2,
          "",
          "The original task and the deliberation so far are preserved in this session. Carry out the action",
          "in light of the new guidance and assessment, then report.",
        ];

  if (input.reviewerVerdict?.status === "needs-user") {
    lines.push(
      "",
      "The reviewer raised an open question. Try to resolve it from the codebase or your own knowledge.",
      "Return `needs-user` only if a genuinely human decision still remains.",
      "",
      "Open question:",
      input.reviewerVerdict.body,
    );
  }

  return lines.join("\n");
}

function requiredOtherBody(input: BuildPromptInput): string {
  if (input.otherBody === undefined) {
    throw new Error(`${input.slot} prompt requires the other slot's body`);
  }
  return input.otherBody;
}
