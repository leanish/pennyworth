/**
 * Shared types and utilities for the drafting layer:
 * - CodingAgent / RunResult / RunProcess types
 * - DraftError
 * - extractFencedMarkdown: parse the last ```markdown block from agent stdout
 * - resolveCodingAgent: flag > env > default
 * - draftDescription: run an agent and extract its markdown output
 */

export type CodingAgent = "codex" | "claude";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunProcess = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; input?: string },
) => Promise<RunResult>;

export class DraftError extends Error {}

const KNOWN_AGENTS: ReadonlySet<string> = new Set<CodingAgent>(["codex", "claude"]);

/**
 * Returns the trimmed body of the last ```markdown fenced block in `stdout`.
 * Falls back to the last bare ``` block if no ```markdown block is present.
 * Returns null when no fenced block is found at all.
 */
export function extractFencedMarkdown(stdout: string): string | null {
  // Try ```markdown blocks first, then bare ``` blocks as fallback.
  const markdownFence = /^```markdown\n([\s\S]*?)^```\s*$/gm;
  const bareFence = /^```\n([\s\S]*?)^```\s*$/gm;

  let last: string | null = null;

  for (const re of [markdownFence, bareFence]) {
    let match: RegExpExecArray | null;
    let found: string | null = null;
    while ((match = re.exec(stdout)) !== null) {
      found = match[1] ?? null;
    }
    if (found !== null) {
      last = found.trimEnd();
      break;
    }
  }

  return last;
}

/**
 * Resolves the coding agent to use from flag > env > default ("codex").
 * Throws if the resolved value is not a known agent.
 */
export function resolveCodingAgent(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): CodingAgent {
  const raw = flag ?? env["CATALOGIT_CODING_AGENT"] ?? "codex";
  if (!KNOWN_AGENTS.has(raw)) {
    throw new Error(`unknown coding agent: "${raw}"`);
  }
  return raw as CodingAgent;
}

/**
 * Runs the coding agent with the given prompt and extracts the markdown block
 * from its stdout. Throws DraftError on non-zero exit or missing fence block.
 */
export async function draftDescription(opts: {
  agent: CodingAgent;
  cwd: string;
  prompt: string;
  runProcess: RunProcess;
}): Promise<string> {
  const { agent, cwd, prompt, runProcess } = opts;

  const argv: string[] = agent === "codex" ? ["exec", prompt] : ["-p", prompt];
  const result = await runProcess(agent, argv, { cwd });

  if (result.code !== 0) {
    const tail = result.stderr.slice(-500);
    throw new DraftError(`${agent} exited with code ${result.code}: ${tail}`);
  }

  const markdown = extractFencedMarkdown(result.stdout);
  if (markdown === null) {
    throw new DraftError(`${agent} output contained no fenced markdown block`);
  }

  return markdown;
}
