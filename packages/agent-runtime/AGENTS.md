# AGENTS.md — agent-runtime

Working rules for any agent editing this repo. Inherits from `~/dev/repos/leanish/specs/agentic-development/AGENTS.md`; key carry-overs below.

## Posture
- **Phase-1 release candidate**, still pre-v1. Concrete decisions; revisit when grilling the spec tree.
- **Specs are the contract.** Specs live in `../../specs/agentic-development/agent-runtime/`. When code and spec disagree, file a grill note and decide.

## Vocabulary
- **American English everywhere.** Anchored on `catalog`.
- **Stage / sourceTrigger** are orthogonal (ADR-0012). Don't conflate.
- **Employer-neutral.** No prior-employer names or company-specific references.
- **No `codex` in commits / PR titles / branch names** unless the change is specifically about Codex itself.

## Code
- Node 24 ESM, TypeScript strict (`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`).
- Prefer explicit names, narrow visibility, immutability.
- Validate at boundaries; fail clearly on invalid input.
- Two-mode discipline: every storage / external-service interface has paired AWS-mode and local-mode implementations.

## Tests
- Vitest. Unit tests against fakes / in-memory implementations.
- Integration tests against LocalStack land alongside AWS-mode adapters when those ship.

## Layout conventions
- One concept per file. Index files re-export the public surface only.
- `src/` source, `test/unit/` unit, `test/e2e/` end-to-end.

## Commits / PRs
- Short, action-oriented, lower-case.
- Never commit without explicit ask.
- Never `git push --force` / `git reset --hard` without explicit ask.

## Suite siblings

`../../agents/ask-the-code/` (ATC backend, package `@leanish/agent-atc`) and `../../agents/secure-it/` (phase-2 agent) depend on this package via `file:../../packages/agent-runtime`, resolved by the root npm workspace.
