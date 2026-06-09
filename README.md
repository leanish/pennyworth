# pennyworth

**leanish** — *a butler for your codebase.* A suite of focused, human-gated AI agents on a shared
runtime: they handle the toil (questions, dependencies, docs, triage, drafts) and hand everything
back **for your review**. Focus on the product, not the plumbing.

## Layout

- **`packages/`** — the framework
  - `catalogit` — the project catalog (read-only library + curation CLI)
  - `agent-runtime` — the shared runtime + bundled skills every agent builds on
  - `agent-infra` — infrastructure-as-code (provisions each agent)
- **`agents/`** — the fleet (each independently deployable)
  - `ask-the-code` — read-only Q&A over the code
  - `secure-it` — keeps dependencies current (proposes PRs)
  - *(document-it · triage-it · ship-it · monitor-it — designed, not yet built)*
- **`tooling/`** — developer tooling (parley relay harness, skills)
- **`docs/`** — intros + the presentation *(to be added)*

> The engineering **design docs** (CONTEXT / overview / ADRs) live in a separate **private specs repo**,
> by design. This repo carries code, intros, and the public front door.

## About this repo

A monorepo consolidation of what were previously separate component repos — **full git history
preserved** for each. Packages still publish and deploy independently; the monorepo just makes the
suite easy to find and work in.
