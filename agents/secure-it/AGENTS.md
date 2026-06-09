# AGENTS.md — agent-secureit

Working rules for any agent editing this repo. Inherits from `../../specs/agentic-development/AGENTS.md`. Key carry-overs:

## Posture
- **Phase-2 placeholder**, still pre-v1.
- **Specs are the contract** — `../../specs/agentic-development/agent-runtime/specs/skills/secureit*.md`, `../../specs/agentic-development/docs/adr/suite-0011-*`.
- **Built on `@leanish/agent-runtime`** (sibling `../agent-runtime/`). Phase-2 helpers are required (`runtime.publish` + `runtime.publishDelayed`); until those land in agent-runtime, this agent's `handle` stays a placeholder.

## Vocabulary
- **American English everywhere.** Anchored on `catalog`.
- **Stage / sourceTrigger** are orthogonal (ADR-0012). Don't conflate.
- **Skill naming**: `secureit` is the breakdown-stage skill (bare agent name); `secureit-revisit` is the revisit-stage skill (`<agent>-<stage>` convention).
- **Branch convention** for opened PRs: `secureit/<context>` (e.g. `secureit/GHSA-xxxx-package`). The prefix is the routing key for the phase-3+ gh-webhook normalization Lambda.

## Code
- Node 24 ESM, TypeScript strict.
- The per-stage dispatch is the load-bearing logic; keep stages cleanly separated.
- The skill is responsible for opening / updating PRs; the handler just orchestrates and schedules the revisit fallback.

## Tests
- Vitest. Unit tests around the stage dispatch + payload handling; integration tests once the AWS-mode adapter + phase-2 runtime helpers land.

## Commits / PRs
- Short, action-oriented, lower-case.
- Never commit without explicit ask.
- Never force-push.
