import { buildPrompt } from "./prompts.js";
import type { BuildPromptInput } from "./prompts.js";
import { shellQuote } from "./shell-quote.js";
import type {
  CodingAgentInvocationError,
  CodingAgentCli,
  MissingCliError,
  ParleyFinal,
  ParleyResult,
  ParleyRunOptions,
  ParleyRunOutput,
  ParleyStep,
  SessionIds,
  Slot,
  Verdict,
} from "./types.js";

export async function runParley(options: ParleyRunOptions): Promise<ParleyRunOutput> {
  if (!Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error("--rounds must be a positive integer");
  }

  const reviewerCli = options.first;
  const actorCli = otherCli(options.first);
  const sessions: SessionIds = { ...options.sessions };
  const sessionAtStart: Record<CodingAgentCli, boolean> = {
    claude: sessions.claude !== undefined,
    codex: sessions.codex !== undefined,
  };
  const firstTurnSeen: Record<CodingAgentCli, boolean> = {
    claude: false,
    codex: false,
  };
  const steps: ParleyStep[] = [];

  let lastVerdict: Verdict | null = null;
  let lastStandingReason: string | null = null;
  let actorBody: string | undefined;
  let completedRounds = 0;

  try {
    for (let round = 1; round <= options.rounds; round += 1) {
      const reviewer = await runTurn({
        cli: reviewerCli,
        slot: "reviewer",
        round,
        prompt: buildPrompt(promptInput({
          slot: "reviewer",
          round,
          prompt1: options.prompt1,
          prompt2: options.prompt2,
          otherBody: actorBody,
          reviewerVerdict: undefined,
          isFirstTurnForSlot: !firstTurnSeen[reviewerCli],
          isResumedSlot: sessionAtStart[reviewerCli],
        })),
        sessions,
        firstTurnSeen,
        runners: options.runners,
        verbose: options.verbose === true,
        onDiagnostic: options.onDiagnostic,
      });
      steps.push(reviewer.step);
      lastVerdict = reviewer.verdict;
      if (reviewer.verdict.status === "error") {
        return failedResult(options, sessions, completedRounds, lastVerdict, steps);
      }
      // A reviewer needs-user is intentionally not terminal. The actor gets the question first and
      // only the round-closing actor can escalate to the human.

      const actor = await runTurn({
        cli: actorCli,
        slot: "actor",
        round,
        prompt: buildPrompt(promptInput({
          slot: "actor",
          round,
          prompt1: options.prompt1,
          prompt2: options.prompt2,
          otherBody: reviewer.verdict.body,
          reviewerVerdict: reviewer.verdict,
          isFirstTurnForSlot: !firstTurnSeen[actorCli],
          isResumedSlot: sessionAtStart[actorCli],
        })),
        sessions,
        firstTurnSeen,
        runners: options.runners,
        verbose: options.verbose === true,
        onDiagnostic: options.onDiagnostic,
      });
      steps.push(actor.step);
      lastVerdict = actor.verdict;
      actorBody = actor.verdict.body;
      if (actor.verdict.status === "error") {
        return failedResult(options, sessions, completedRounds, lastVerdict, steps);
      }

      completedRounds = round;
      if (reviewer.verdict.status === "agree" && actor.verdict.status === "agree") {
        return completeResult({
          status: "settled",
          exitCode: 0,
          options,
          sessions,
          roundsExecuted: completedRounds,
          final: {
            summary: actor.verdict.summary,
            result: actor.verdict.body,
            agreement: reviewer.verdict.summary,
            disagreement: null,
          },
          steps,
        });
      }

      if (actor.verdict.status === "needs-user") {
        return completeResult({
          status: "needs-user",
          exitCode: 3,
          options,
          sessions,
          roundsExecuted: completedRounds,
          final: {
            summary: actor.verdict.summary,
            result: actor.verdict.body,
            agreement: null,
            disagreement: null,
          },
          steps,
        });
      }

      lastStandingReason = standingReason(reviewer.verdict, actor.verdict);
    }
  } catch (error) {
    if (isMissingCliError(error)) {
      throw error;
    }
    recordSessionFromError(sessions, error);
    return failedResult(options, sessions, completedRounds, lastVerdict, steps, error);
  }

  return completeResult({
    status: "deadlocked",
    exitCode: 2,
    options,
    sessions,
    roundsExecuted: completedRounds,
    final: {
      summary: lastVerdict?.summary ?? null,
      result: lastVerdict?.body ?? null,
      agreement: null,
      disagreement: lastStandingReason,
    },
    steps,
  });
}

function otherCli(cli: CodingAgentCli): CodingAgentCli {
  return cli === "codex" ? "claude" : "codex";
}

function promptInput(input: {
  slot: Slot;
  round: number;
  prompt1: string;
  prompt2: string | undefined;
  otherBody: string | undefined;
  reviewerVerdict: Verdict | undefined;
  isFirstTurnForSlot: boolean;
  isResumedSlot: boolean;
}): BuildPromptInput {
  return {
    slot: input.slot,
    round: input.round,
    prompt1: input.prompt1,
    ...(input.prompt2 === undefined ? {} : { prompt2: input.prompt2 }),
    ...(input.otherBody === undefined ? {} : { otherBody: input.otherBody }),
    ...(input.reviewerVerdict === undefined ? {} : { reviewerVerdict: input.reviewerVerdict }),
    isFirstTurnForSlot: input.isFirstTurnForSlot,
    isResumedSlot: input.isResumedSlot,
  };
}

type RunTurnInput = {
  cli: CodingAgentCli;
  slot: Slot;
  round: number;
  prompt: string;
  sessions: SessionIds;
  firstTurnSeen: Record<CodingAgentCli, boolean>;
  runners: ParleyRunOptions["runners"];
  verbose: boolean;
  onDiagnostic: ((message: string) => void) | undefined;
};

async function runTurn(input: RunTurnInput): Promise<{ verdict: Verdict; step: ParleyStep }> {
  const sessionId = input.sessions[input.cli];
  if (input.verbose) {
    const mode = sessionId === undefined ? "new session" : `resume ${sessionId}`;
    input.onDiagnostic?.(`round ${input.round}: ${input.slot} -> ${input.cli} (${mode})`);
  }
  const output = await input.runners[input.cli].run({
    cli: input.cli,
    prompt: input.prompt,
    ...(sessionId === undefined ? {} : { sessionId }),
    verbose: input.verbose,
  });

  input.firstTurnSeen[input.cli] = true;
  input.sessions[input.cli] = output.sessionId;

  return {
    verdict: output.verdict,
    step: {
      round: input.round,
      slot: input.slot,
      cli: input.cli,
      prompt: input.prompt,
      body: output.verdict.body,
      status: output.verdict.status,
      summary: output.verdict.summary,
      reason: output.verdict.reason,
      sessionId: output.sessionId,
    },
  };
}

type CompleteResultInput = {
  status: "settled" | "deadlocked" | "needs-user";
  exitCode: 0 | 2 | 3;
  options: ParleyRunOptions;
  sessions: SessionIds;
  roundsExecuted: number;
  final: ParleyFinal;
  steps: readonly ParleyStep[];
};

function completeResult(input: CompleteResultInput): ParleyRunOutput {
  const continuation =
    input.status === "deadlocked" || input.status === "needs-user"
      ? buildContinuation(input.options.first, input.sessions)
      : undefined;

  return {
    exitCode: input.exitCode,
    result: withOptionalContinuation(
      {
        status: input.status,
        roundsExecuted: input.roundsExecuted,
        maxRounds: input.options.rounds,
        first: input.options.first,
        sessions: presentSessions(input.sessions),
        final: input.final,
      },
      continuation,
    ),
    steps: input.steps,
  };
}

function failedResult(
  options: ParleyRunOptions,
  sessions: SessionIds,
  completedRounds: number,
  lastVerdict: Verdict | null,
  steps: readonly ParleyStep[],
  error?: unknown,
): ParleyRunOutput {
  const final: ParleyFinal = {
    summary: error === undefined ? (lastVerdict?.summary ?? null) : "coding agent invocation failed",
    result: failureBody(lastVerdict, error),
    agreement: null,
    disagreement: null,
  };

  return {
    exitCode: 4,
    result: {
      status: "failed",
      roundsExecuted: completedRounds,
      maxRounds: options.rounds,
      first: options.first,
      sessions: presentSessions(sessions),
      final,
    },
    steps,
  };
}

function failureBody(lastVerdict: Verdict | null, error?: unknown): string | null {
  if (error !== undefined) {
    return error instanceof Error ? error.message : String(error);
  }
  if (lastVerdict !== null) {
    return lastVerdict.body;
  }
  return null;
}

function standingReason(reviewer: Verdict, actor: Verdict): string | null {
  if (actor.status === "disagree") {
    return actor.reason;
  }
  if (reviewer.status === "disagree" || reviewer.status === "needs-user") {
    return reviewer.reason;
  }
  return null;
}

function buildContinuation(first: CodingAgentCli, sessions: SessionIds): string {
  if (sessions.codex === undefined || sessions.claude === undefined) {
    throw new Error("continuation requires both session ids");
  }

  return [
    "parley",
    "--first",
    shellQuote(first),
    "--codex-session",
    shellQuote(sessions.codex),
    "--claude-session",
    shellQuote(sessions.claude),
    shellQuote("<your guidance / next prompt>"),
    "[<action>]",
  ].join(" ");
}

function presentSessions(sessions: SessionIds): SessionIds {
  const result: SessionIds = {};
  if (sessions.claude !== undefined) {
    result.claude = sessions.claude;
  }
  if (sessions.codex !== undefined) {
    result.codex = sessions.codex;
  }
  return result;
}

function withOptionalContinuation(result: ParleyResult, continuation: string | undefined): ParleyResult {
  if (continuation === undefined) {
    return result;
  }
  return { ...result, continuation };
}

function isMissingCliError(error: unknown): error is MissingCliError {
  return error instanceof Error && error.name === "MissingCliError";
}

function recordSessionFromError(sessions: SessionIds, error: unknown): void {
  if (!isInvocationError(error) || error.sessionId === undefined) {
    return;
  }
  sessions[error.cli] = error.sessionId;
}

function isInvocationError(error: unknown): error is CodingAgentInvocationError {
  return (
    error instanceof Error &&
    typeof (error as { cli?: unknown }).cli === "string" &&
    ((error as { cli?: unknown }).cli === "codex" || (error as { cli?: unknown }).cli === "claude")
  );
}
