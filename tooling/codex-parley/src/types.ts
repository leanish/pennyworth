export type CodingAgentCli = "codex" | "claude";

export type Slot = "reviewer" | "actor";

export type VerdictStatus = "agree" | "disagree" | "needs-user" | "error";

export type ParleyStatus = "settled" | "deadlocked" | "needs-user" | "failed";

export type FirstCli = CodingAgentCli;

export type Verdict = {
  status: VerdictStatus;
  summary: string;
  reason: string;
  body: string;
};

export type SessionIds = {
  claude?: string;
  codex?: string;
};

export type ParleyFinal = {
  summary: string | null;
  result: string | null;
  agreement: string | null;
  disagreement: string | null;
};

export type ParleyResult = {
  status: ParleyStatus;
  roundsExecuted: number;
  maxRounds: number;
  first: FirstCli;
  sessions: SessionIds;
  final: ParleyFinal;
  continuation?: string;
};

export type ParleyStep = {
  round: number;
  slot: Slot;
  cli: CodingAgentCli;
  prompt: string;
  body: string;
  status: VerdictStatus;
  summary: string;
  reason: string;
  sessionId: string;
};

export type RunnerInvocation = {
  cli: CodingAgentCli;
  prompt: string;
  sessionId?: string;
  verbose: boolean;
};

export type RunnerOutput = {
  sessionId: string;
  verdict: Verdict;
};

export type CodingAgentRunner = {
  run(invocation: RunnerInvocation): Promise<RunnerOutput>;
};

export type RunnerMap = Record<CodingAgentCli, CodingAgentRunner>;

export type ParleyRunOptions = {
  prompt1: string;
  prompt2?: string;
  rounds: number;
  first: FirstCli;
  sessions: SessionIds;
  runners: RunnerMap;
  verbose?: boolean;
  onDiagnostic?: (message: string) => void;
};

export type ParleyRunOutput = {
  exitCode: 0 | 2 | 3 | 4;
  result: ParleyResult;
  steps: readonly ParleyStep[];
};

export class CodingAgentInvocationError extends Error {
  readonly cli: CodingAgentCli;
  readonly sessionId?: string;

  constructor(cli: CodingAgentCli, message: string, options: (ErrorOptions & { sessionId?: string }) = {}) {
    super(message, options);
    this.name = "CodingAgentInvocationError";
    this.cli = cli;
    if (options.sessionId !== undefined) {
      this.sessionId = options.sessionId;
    }
  }
}

export class MissingCliError extends Error {
  readonly cli: CodingAgentCli;

  constructor(cli: CodingAgentCli, cause?: unknown) {
    super(`missing required CLI on PATH: ${cli}`, { cause });
    this.name = "MissingCliError";
    this.cli = cli;
  }
}
