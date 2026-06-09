# Monorepo consolidation — history audit

`pennyworth` was assembled from the previously-separate `agentic-development/*` repos. This records
what was imported, where it landed, and how prior history was preserved — so the "all history
preserved" claim is reviewable.

## Imported packages (live tree + full history)

Each repo's chosen branch was imported (files at the new path; commits reachable in the DAG). **Every
commit reachable from any branch / remote-tracking branch / stash of each source is present** in
`pennyworth` (verified: `git cat-file -e` per source-reachable SHA → 0 missing).

| Source repo | Imported branch (live tree) | New path | Source tip |
|---|---|---|---|
| `catalogit` | `improvement/catalogit-maintainability-cleanup` | `packages/catalogit` | `ee1bf83` |
| `agent-runtime` | `improvement/agent-runtime-maintainability-cleanup` | `packages/agent-runtime` | `2b0151a` |
| `agent-atc` | `improvement/agent-atc-maintainability-cleanup` | `agents/ask-the-code` | `0398044` |
| `agent-secureit` | `main` | `agents/secure-it` | `d8dcfad` |
| `agent-infra` | *(no prior git history — was untracked)* | `packages/agent-infra` | — (copied) |

## Archived refs (every other branch / remote / stash)

To preserve commits not on the imported branch, all other refs were fetched into pushable
`archive/<repo>/...` branches (22 refs): every local head, every `origin/*` remote-tracking branch,
and every stash tip. Example of commits this rescued:
- `agent-runtime`: `78b4cb4`, `fa825bb` (on `main`, not on the imported cleanup branch).
- Stashes: `catalogit` ×1, `agent-runtime` ×1 (archived as `archive/<repo>/stash-N`).

## Carried-over uncommitted WIP

`catalogit`'s working tree had uncommitted work, overlaid and committed at consolidation:
- `catalogit` — typed errors (`errors.ts`, `parse-project-record.ts`) + tests.

## Deliberately excluded

- **`claude-parley` / `codex-parley`** — discarded PoCs (no git repo; dropped on cost grounds). Not
  carried into the monorepo.
- **`leanish-skills`** — an **independent project** with its own repo (pennyworth may *use* it, but it
  stands alone). Kept out; its own repo remains the source of truth for its history.

## Layout changes applied during the move

- Folder renames: `agent-atc → agents/ask-the-code`, `agent-secureit → agents/secure-it`.
- Cross-boundary deps fixed to `file:../../packages/…`; intra-`packages/` deps unchanged.
- ATC `Dockerfile`, agent-infra `registry.ts`, and ATC scripts updated to the new layout.
- Per-package lockfiles dropped in favour of a single root lockfile (run `npm install` at the root).

> Package `name` fields still use the original ids (e.g. `agents/ask-the-code` is `@leanish/agent-atc`).
> Aligning names to folders is a deliberate, separate follow-up.
