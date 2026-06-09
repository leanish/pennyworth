# AGENTS.md — catalogit

Working rules for any agent editing this repo. Inherits from `../../specs/agentic-development/AGENTS.md`. Key carry-overs:

## Posture
- **Phase-1 release candidate**, still pre-v1.
- **Specs are the contract** — `../../specs/agentic-development/catalogit/` is the source of truth for the data format and library API.
- **Read-only library.** catalogit owns the catalog SHAPE; catalog WRITES live in the (deferred) `catalogit` CLI, not in this library. Agents only consume catalogit's reader interfaces.

## Vocabulary
- **American English everywhere.** Anchored on `catalog`.
- **Project** is the canonical record. `ProjectSource` carries the clone URL + branch.
- **"For-consumer" filtering** — `forConsumer(<agent-id>)` applies the default-on opt-in convention (`extensions.<agent>.enabled !== false`).

## Code
- Node 24 ESM, TypeScript strict.
- One concept per file. `index.ts` re-exports the public surface only.
- Two-mode discipline: `FilesystemCatalog` is the local-mode reader; `S3Catalog` is the AWS-mode reader; `InMemoryCatalog` is the test-only reader. All implement the same `CatalogReadOnly` interface.

## Tests
- Vitest. Each impl has its own unit test file.

## Commits / PRs
- Short, action-oriented, lower-case.
- Never commit without explicit ask.
- Never force-push.
