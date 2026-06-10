import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LoadedSkill } from "./skill.js";

/**
 * Stages an entrypoint + support skills into a temp directory using the
 * canonical Claude Code `--plugin-dir` layout (ADR-0001 + ADR-0002):
 *
 *   <staged>/
 *   ├── .claude-plugin/plugin.json
 *   └── skills/
 *       ├── <entrypoint>/SKILL.md
 *       └── <support>/SKILL.md   (one per support skill)
 *
 * Each skill is copied **byte-identical** from its source directory using
 * `fs.cp` (recursive). This preserves any companion files the skill author
 * shipped (scripts/, references/, examples/, etc.) without round-tripping
 * the frontmatter through a YAML emitter.
 *
 * The runtime owns the temp directory; nothing is written into agent or
 * working-copy directories. Caller is responsible for calling `cleanup()`
 * when the subprocess finishes (including on error paths).
 *
 * If the same skill name appears in both the entrypoint and support lists,
 * the entrypoint version wins (per descriptor.md compatibility note about
 * the runtime de-duplicating).
 */
export interface StagedSkills {
  readonly dir: string;
  cleanup(): Promise<void>;
}

export interface StageSkillsArgs {
  readonly entrypoint: LoadedSkill;
  readonly supportSkills: ReadonlyArray<LoadedSkill>;
  /** Optional override for the temp directory parent (defaults to `os.tmpdir()`). */
  readonly parentDir?: string;
  /** Optional plugin name written into the manifest. */
  readonly pluginName?: string;
}

export async function stageSkills(args: StageSkillsArgs): Promise<StagedSkills> {
  const parent = args.parentDir ?? tmpdir();
  const dir = await mkdtemp(join(parent, "agent-runtime-skill-"));
  try {
    await writePluginManifest(dir, args.pluginName ?? "agent-runtime-staged");
    await mkdir(join(dir, "skills"), { recursive: true });
    await copySkillDir(dir, args.entrypoint);
    const seen = new Set<string>([args.entrypoint.name]);
    for (const support of args.supportSkills) {
      if (seen.has(support.name)) continue;
      seen.add(support.name);
      await copySkillDir(dir, support);
    }
    return {
      dir,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function writePluginManifest(dir: string, name: string): Promise<void> {
  const manifestDir = join(dir, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  const manifest = {
    name,
    version: "0.0.0",
    description: "Skills staged by @leanish/runtime for one runSkill invocation.",
  };
  await writeFile(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Copy `<source-skill-dir>/` → `<staged>/skills/<name>/` recursively.
 *
 * `LoadedSkill.path` points at the source `SKILL.md`; the directory we
 * actually want is its parent. `fs.cp` with `recursive: true` walks the
 * tree and preserves byte-identical content (modulo file metadata).
 */
async function copySkillDir(stagedRoot: string, skill: LoadedSkill): Promise<void> {
  const dest = join(stagedRoot, "skills", skill.name);
  const sourceDir = dirname(skill.path);
  await cp(sourceDir, dest, { recursive: true });
}
