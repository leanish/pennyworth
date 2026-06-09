import type { AgentRunner } from "../src/index.js";
import type { Cli, Verdict } from "../src/index.js";

export type Scripted = Verdict | "throw";

/**
 * A scripted AgentRunner for unit tests — no real CLI. Returns the scripted verdict per turn
 * (clamping to the last entry), records prompts, and self-assigns a session id on first run unless
 * one was provided up front (mimicking Claude's preset id vs Codex's captured id).
 */
export class MockRunner implements AgentRunner {
  readonly cli: Cli;
  readonly prompts: string[] = [];
  #sessionId: string | undefined;
  readonly #script: readonly Scripted[];
  #index = 0;

  constructor(cli: Cli, script: readonly Scripted[], sessionId?: string) {
    this.cli = cli;
    this.#script = script;
    this.#sessionId = sessionId;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async run(prompt: string): Promise<Verdict> {
    this.prompts.push(prompt);
    const step = this.#script[Math.min(this.#index, this.#script.length - 1)];
    this.#index += 1;
    if (step === undefined || step === "throw") {
      throw new Error(`${this.cli} boom`);
    }
    if (this.#sessionId === undefined) {
      this.#sessionId = `${this.cli}-session`;
    }
    return step;
  }
}

export function verdict(status: Verdict["status"], extra?: Partial<Verdict>): Verdict {
  return {
    status,
    summary: extra?.summary ?? `${status} summary`,
    reason: extra?.reason ?? `${status} reason`,
    body: extra?.body ?? `${status} body`,
  };
}
