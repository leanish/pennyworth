/**
 * Orchestrates the `catalogit discover` flow:
 * list a GitHub owner's repos → select a subset → import each via runAdd.
 *
 * All I/O is injected through DiscoverDeps so tests run without network or
 * subprocess access.
 */

import type { CodingAgent } from "./coding-agent.js";
import type { GhRepo } from "./github.js";
import { listRepos } from "./github.js";
import { projectFileExists } from "./project-writer.js";
import { mapRepoToId } from "./repo-id.js";
import { type AddDeps, type AddStatus, runAdd } from "./add.js";

export interface DiscoverDeps extends AddDeps {
  readonly listRepos: typeof listRepos;
  readonly select: (
    choices: { name: string; value: string; checked?: boolean }[],
  ) => Promise<string[]>;
}

export interface DiscoverOptions {
  readonly owner?: string;
  readonly includeArchived: boolean;
  readonly add?: readonly string[];
  readonly agent: CodingAgent;
  readonly force: boolean;
  readonly skeleton: boolean;
  readonly catalogRoot: string;
  readonly isTty: boolean;
}

export interface DiscoverSummary {
  readonly added: readonly string[];
  readonly overridden: readonly string[];
  readonly skeleton: readonly string[];
  readonly skipped: readonly { readonly repo: string; readonly reason: string }[];
}

const EMPTY_SUMMARY: DiscoverSummary = {
  added: [],
  overridden: [],
  skeleton: [],
  skipped: [],
};

/** Classify a written-file status into its summary bucket name. */
function writtenBucket(status: AddStatus): "added" | "overridden" | "skeleton" | null {
  if (status === "added") return "added";
  if (status === "overridden") return "overridden";
  if (status === "skeleton") return "skeleton";
  return null; // "skipped"
}

export async function runDiscover(
  o: DiscoverOptions,
  d: DiscoverDeps,
): Promise<{ summary: DiscoverSummary; exitCode: number }> {
  // 1. Fetch eligible repos
  const repos = await d.listRepos({
    ...(o.owner !== undefined ? { owner: o.owner } : {}),
    includeArchived: o.includeArchived,
    runGh: d.runGh,
  });

  // 2. Determine which repos to import
  let selected: readonly GhRepo[];
  const extraSkipped: { repo: string; reason: string }[] = [];

  if (o.add !== undefined) {
    if (o.add.includes("*")) {
      selected = repos;
    } else {
      const lowerAdd = o.add.map((n) => n.toLowerCase());
      const repoMap = new Map(repos.map((r) => [r.name.toLowerCase(), r]));

      selected = lowerAdd
        .map((lower) => repoMap.get(lower))
        .filter((r): r is GhRepo => r !== undefined);

      for (const name of o.add) {
        if (!repoMap.has(name.toLowerCase())) {
          extraSkipped.push({ repo: name, reason: "not found among eligible repos" });
        }
      }
    }
  } else {
    if (!o.isTty) {
      process.stderr.write(
        "discover: no TTY and no --add; pass --add <names> or --add '*'\n",
      );
      return { summary: EMPTY_SUMMARY, exitCode: 1 };
    }

    // Build interactive choices; mark already-cataloged repos
    const choices: { name: string; value: string; checked?: boolean }[] = [];
    for (const repo of repos) {
      const m = mapRepoToId(repo.owner, repo.name);
      let label = repo.name;
      if (m.ok) {
        const exists = await projectFileExists(o.catalogRoot, m.id);
        if (exists) {
          label = `${repo.name} [cataloged — will re-draft]`;
        }
      }
      choices.push({ name: label, value: repo.name, checked: false });
    }

    const pickedNames = await d.select(choices);
    const pickedSet = new Set(pickedNames.map((n) => n.toLowerCase()));
    selected = repos.filter((r) => pickedSet.has(r.name.toLowerCase()));
  }

  // 3. Import each selected repo sequentially
  const added: string[] = [];
  const overridden: string[] = [];
  const skeleton: string[] = [];
  const skipped: { repo: string; reason: string }[] = [...extraSkipped];

  for (const repo of selected) {
    const m = mapRepoToId(repo.owner, repo.name);
    if (!m.ok) {
      skipped.push({ repo: repo.name, reason: m.reason });
      continue;
    }

    const r = await runAdd(
      {
        id: m.id,
        catalogRoot: o.catalogRoot,
        agent: o.agent,
        force: o.force,
        skeleton: o.skeleton,
        isTty: o.isTty,
      },
      {
        runProcess: d.runProcess,
        runGh: d.runGh,
        runGit: d.runGit,
        confirm: d.confirm,
      },
    );

    const bucket = writtenBucket(r.status);
    if (bucket === "added") added.push(m.id);
    else if (bucket === "overridden") overridden.push(m.id);
    else if (bucket === "skeleton") skeleton.push(m.id);
    else skipped.push({ repo: repo.name, reason: "already cataloged (use --force) or invalid" });
  }

  // 4. Print summary
  const writtenCount = added.length + overridden.length + skeleton.length;
  process.stdout.write(
    `discover: ${writtenCount} written (${added.length} added, ${overridden.length} overridden, ${skeleton.length} skeleton), ${skipped.length} skipped\n`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) {
      process.stdout.write(`  skipped ${s.repo}: ${s.reason}\n`);
    }
  }

  // 5. Exit code: 0 if at least one written OR nothing selected; 1 if some selected but none written
  const nothingSelected = selected.length === 0 && extraSkipped.length === 0;
  const exitCode = writtenCount > 0 || nothingSelected ? 0 : 1;

  return {
    summary: { added, overridden, skeleton, skipped },
    exitCode,
  };
}
