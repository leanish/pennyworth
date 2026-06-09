# AGENTS.md — codex-parley

Working rules for this package. Inherits from `../../specs/agentic-development/AGENTS.md` and the
workspace-level guidance.

## Posture

- Phase-1 release candidate.
- Specs are the contract: `../../specs/agentic-development/parley/` is the source of truth.
- Standalone local developer tool. No dependency on `agent-runtime`, `catalogit`, or `agent-infra`.

## Vocabulary

- Use **parley** for the tool.
- Use **coding agent** for `codex` and `claude`.
- Avoid the bare word "agent" unless referring to another suite concept.

## Code

- Node 24 ESM, TypeScript strict.
- One concept per file. `index.ts` re-exports the public surface.
- Keep subprocess handling isolated behind runner interfaces so the relay loop stays testable.

## Tests

- Vitest.
- Cover relay decisions, prompt shape, CLI parsing/output, and runner parsing without requiring real
  `codex` / `claude` invocations.

## Commits / PRs

- Short, action-oriented, lower-case.
- Never commit without explicit ask.
- Never force-push.
