# AGENTS.md — agent-atc

Working rules for any agent editing this repo. Inherits from `../../specs/agentic-development/AGENTS.md`. Key carry-overs:

## Posture
- **Phase-1 release candidate**, still pre-v1.
- **Specs are the contract** — `../../specs/agentic-development/agent-atc/`.
- **Built on `@leanish/agent-runtime`** (sibling `../agent-runtime/`). Local-dev linked via `file:../agent-runtime`; production install resolves the published version.

## Vocabulary
- **American English everywhere.** Anchored on `catalog`.
- **`envelope.kind: "ask"` stays on the wire** (ATC's domain vocabulary). It's distinct from `RuntimeMessage.stage`. Don't rename.
- **Stage / sourceTrigger** are orthogonal (ADR-0012).

## Code
- Node 24 ESM, TypeScript strict.
- Validate request shape at the handler boundary; fail clearly on invalid input.
- The 6-step handler transformation (envelope → skill input) is the load-bearing logic. Keep it readable.

## Tests
- Vitest. Unit tests around the transformation; integration tests once the AWS-mode adapter lands.

## Commits / PRs
- Short, action-oriented, lower-case.
- Never commit without explicit ask.
- Never force-push.
