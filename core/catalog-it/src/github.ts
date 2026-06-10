/**
 * Thin wrapper around the `gh` CLI for repository listing and metadata fetching.
 * All subprocess execution goes through injected `RunGh` seams — no real processes in tests.
 */

import type { RunResult } from "./coding-agent.js";

export interface GhRepo {
  readonly name: string;
  readonly owner: string;
  readonly isArchived: boolean;
  readonly isFork: boolean;
  readonly url: string;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly topics: readonly string[];
}

export type RunGh = (args: readonly string[]) => Promise<RunResult>;

export class GhError extends Error {}

const GH_AUTH_HINT = "Ensure the `gh` CLI is installed and authenticated: `gh auth login`";

interface RawRepoEntry {
  name: string;
  owner: { login: string };
  isArchived: boolean;
  isFork: boolean;
  url: string;
  defaultBranchRef?: { name: string } | null;
  description: string | null;
  // gh emits null (not []) for repos with no topics.
  repositoryTopics: Array<string | { name: string }> | null;
}

function normalizeTopics(raw: Array<string | { name: string }> | null): readonly string[] {
  return (raw ?? []).map(t => (typeof t === "string" ? t : t.name));
}

function toGhRepo(entry: RawRepoEntry): GhRepo {
  return {
    name: entry.name,
    owner: entry.owner.login,
    isArchived: entry.isArchived,
    isFork: entry.isFork,
    url: entry.url,
    defaultBranch: entry.defaultBranchRef?.name ?? "main",
    description: entry.description,
    topics: normalizeTopics(entry.repositoryTopics),
  };
}

/**
 * Lists repositories via `gh repo list`.
 * When `owner` is omitted, lists the authenticated user's repositories.
 * Archived repos are filtered out unless `includeArchived` is true.
 * Forks are always kept.
 */
export async function listRepos(opts: {
  owner?: string;
  includeArchived: boolean;
  runGh: RunGh;
}): Promise<readonly GhRepo[]> {
  const { owner, includeArchived, runGh } = opts;
  const args: string[] = [
    "repo",
    "list",
    ...(owner !== undefined ? [owner] : []),
    "--json",
    "name,owner,isArchived,isFork,url,defaultBranchRef,description,repositoryTopics",
    "--limit",
    "1000",
  ];

  const result = await runGh(args);
  if (result.code !== 0) {
    throw new GhError(
      `gh repo list failed (exit ${result.code}): ${result.stderr}\n${GH_AUTH_HINT}`,
    );
  }

  const entries = JSON.parse(result.stdout) as RawRepoEntry[];
  const repos = entries.map(toGhRepo);
  return includeArchived ? repos : repos.filter(r => !r.isArchived);
}

/**
 * Fetches description and topics for a single repository.
 */
export async function getRepoMeta(opts: {
  owner: string;
  repo: string;
  runGh: RunGh;
}): Promise<{ description: string | null; topics: readonly string[] }> {
  const { owner, repo, runGh } = opts;
  const result = await runGh([
    "repo",
    "view",
    `${owner}/${repo}`,
    "--json",
    "description,repositoryTopics",
  ]);

  if (result.code !== 0) {
    throw new GhError(
      `gh repo view failed (exit ${result.code}): ${result.stderr}\n${GH_AUTH_HINT}`,
    );
  }

  const raw = JSON.parse(result.stdout) as {
    description: string | null;
    repositoryTopics: Array<string | { name: string }> | null;
  };

  return {
    description: raw.description,
    topics: normalizeTopics(raw.repositoryTopics),
  };
}
