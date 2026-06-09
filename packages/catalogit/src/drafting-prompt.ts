/**
 * Builds the prompt sent to a coding agent when drafting a catalog description
 * for a given project.
 */

export interface DraftingPromptOpts {
  /** Canonical catalog id, e.g. "leanish/agent-atc". */
  readonly id: string;
  /** Optional GitHub metadata to include as additional context. */
  readonly githubMeta?: {
    readonly description: string | null;
    readonly topics: readonly string[];
  };
}

/**
 * Returns a prompt string instructing the coding agent to produce a catalog
 * description for the project identified by `id`.
 *
 * The prompt ends with an explicit instruction to respond with a single
 * ```markdown fenced block containing only the description body.
 */
export function buildDraftingPrompt(opts: DraftingPromptOpts): string {
  const { id, githubMeta } = opts;

  const githubSection =
    githubMeta !== undefined
      ? `\n## GitHub metadata\n- Description: ${githubMeta.description ?? "(none)"}\n- Topics: ${githubMeta.topics.length > 0 ? githubMeta.topics.join(", ") : "(none)"}\n`
      : "";

  return `You are helping maintain a catalog of AI agents and developer tools. Your task is to write a concise catalog description for the project \`${id}\`.

## Suggested sections
Write a short Markdown document covering these areas (omit sections you cannot determine):

- **What this agent does** — one or two sentences describing the primary purpose.
- **Stack** — main languages, frameworks, or platforms.
- **Notes for routing** — keywords or capabilities that help match this project to relevant tasks.
- **Owners** — team or individual responsible (if determinable from the codebase).
- **Workflows** — key CI/CD or automation patterns in use.
${githubSection}
## Worked example
For a project called \`leanish/shipit\` the description might look like:

\`\`\`markdown
## What it does
Automates release pull-request creation and changelog generation for Node.js projects.

## Stack
TypeScript, Node 20, GitHub Actions.

## Notes for routing
release automation, changelog, semver, pull-request.
\`\`\`

## Instructions
1. Inspect the repository code in the current working directory to gather facts.
2. Write a description following the structure above.
3. End your response with **a single \`\`\`markdown fenced block** that contains only the description body — no preamble, no YAML front-matter, no trailing commentary.
`;
}
