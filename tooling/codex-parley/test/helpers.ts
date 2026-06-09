import type { CodingAgentCli, CodingAgentRunner, RunnerInvocation, RunnerMap, RunnerOutput, Verdict } from "../src/index.js";

export type RecordedInvocation = RunnerInvocation;

export function scriptedRunners(script: Partial<Record<CodingAgentCli, Verdict[]>>): {
  runners: RunnerMap;
  invocations: RecordedInvocation[];
} {
  const invocations: RecordedInvocation[] = [];
  return {
    runners: {
      claude: new ScriptedRunner("claude", script.claude ?? [], invocations),
      codex: new ScriptedRunner("codex", script.codex ?? [], invocations),
    },
    invocations,
  };
}

export function verdict(status: Verdict["status"], body = `${status} body`): Verdict {
  return {
    status,
    summary: `${status} summary`,
    reason: `${status} reason`,
    body,
  };
}

class ScriptedRunner implements CodingAgentRunner {
  readonly #cli: CodingAgentCli;
  readonly #verdicts: Verdict[];
  readonly #invocations: RecordedInvocation[];
  #index = 0;

  constructor(cli: CodingAgentCli, verdicts: Verdict[], invocations: RecordedInvocation[]) {
    this.#cli = cli;
    this.#verdicts = verdicts;
    this.#invocations = invocations;
  }

  async run(invocation: RunnerInvocation): Promise<RunnerOutput> {
    this.#invocations.push(invocation);
    const verdict = this.#verdicts[this.#index];
    this.#index += 1;
    if (verdict === undefined) {
      throw new Error(`no scripted verdict for ${this.#cli} turn ${this.#index}`);
    }
    return {
      sessionId: invocation.sessionId ?? `${this.#cli}-session`,
      verdict,
    };
  }
}
