# AGENTS.md — agent-secure-it

Working rules for any agent editing this package. Key carry-overs from the shared agent guidelines:

## Posture
- **Implemented and tested**, deploy wiring partially deferred — see `SCOPE.md` + `ASSUMPTIONS.md`.
- **Built on `@leanish/runtime`** (sibling `../../core/runtime/`); uses the phase-2 helpers `runtime.publish` + `runtime.publishDelayed`.

## Vocabulary
- **American English everywhere.** Anchored on `catalog`.
- **Stage / sourceTrigger** are orthogonal. Don't conflate.
- **Skill naming**: `secure-it` is the breakdown-stage skill (bare agent name); `secure-it-revisit` is the revisit-stage skill (`<agent>-<stage>` convention).
- **Branch convention** for opened PRs: `secure-it/<alertRef>` (e.g. `secure-it/GHSA-xxxx-package`). The prefix is the routing key for a future webhook-driven revisit source.

## Code
- Node 24 ESM, TypeScript strict.
- The per-stage dispatch is the load-bearing logic; keep stages cleanly separated.
- The skills own all GitHub work (open / update / flip / rollback PRs via `gh`); the handler just orchestrates and schedules the revisit follow-ups.
- The revisit cap lives in the handler — the skill only ever *requests* a reschedule.

## Tests
- Vitest, hermetic: real descriptor + real SKILL.md files, fake runner + in-memory adapters from `@leanish/runtime/testing`.
- `npm run check` must stay green.

## Commits / PRs
- Short, action-oriented, lower-case.
- Never commit without explicit ask.
- Never force-push.
