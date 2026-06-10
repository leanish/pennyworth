# `@leanish/ship-it`

Ticket-lifecycle Layer-3 agent: shepherds a ticket through its workflow states by running the
matching `-it` skill for each state, with a person at every gate. It never merges, deploys, or
transitions a ticket — it proposes (draft PRs, comments) and humans decide.

Built on `@leanish/runtime`. See `1-pager.md` for the plain-language overview and
`ASSUMPTIONS.md` for the phase-1 decisions.

## Status — rollout step 1: `groom-it` (everything else merged dark)

**Released today: `groom-it` only** — the least brittle step starts the rollout: it touches no
working copy, no GitHub, runs no loops; it assesses a labelled ticket against scrum-standard
quality and proposes a groomed rewrite as a comment. The remaining steps are implemented but dark
(`released: false` — work-in-progress; flip one boolean in `src/steps.ts` to launch each):

- **`code-it`** — a ticket a human moved to *Ready for Implementation* (and labelled `ship-it`, on
  an opted-in project) gets implemented in the project working copy, tested with the project's own
  suite, and opened as a **draft PR**.
- **`code-it-revisit`** — a self-scheduled loop (runtime `publishDelayed`, bounded at 3 cycles)
  polls CI on the draft PR: green → flip to ready-for-review; red → fix and push, or close the PR
  and delete the branch; pending → poll again.

Later steps ride the same status → step map, gated by the **step registry** (`src/steps.ts`): each
step carries a `released` switch, so a step can be developed and merged dark, then launched by
flipping one boolean (plus declaring its skill entrypoint — a test pins the invariant).

**Implemented, merged dark** (runner + skill shipped; flip `released` to launch):

- **`spec-it`** — refines the ticket's specification grounded in the project's actual code;
  iterates with people via ticket comments; suggests (never performs) the handoff to implementation.
- **`review-it`** — reviews a ready-for-review PR. When the environment provides a consensus skill
  and a second model's CLI, the review runs **cross-model**: both models review independently and
  argue findings to agreement, and the output reports `verificationMode: "cross-model-consensus"`;
  otherwise it falls back to single-model and says so. Comment-only — never approves, never merges.
- **`validate-it`** — read-only verification that the deployed change behaves as the ticket
  promised: derives checks from the acceptance criteria, probes the deployed system ONLY through
  the project-provided `extensions.ship-it.validation` contract, reports pass/fail per check.
  Never mutates anything; release-blocked until a real deploy (and its trigger seam) exists.

**Design pending** (registry entry only, no runner): **`mock-it-up`** (needs a design-tool seam).

## Gates

1. **Repo opt-in** — the project must carry `extensions.ship-it.enabled === true` in the catalog
   (strict: absence means not opted in).
2. **Per-ticket opt-in** — the ticket must carry the `ship-it` label (asserted by the upstream
   normalizer and re-asserted in the handler).
3. **Human handoff** — only the mapped ticket status triggers work; a human performs that
   transition, and every merge after it.

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test
npm run check      # typecheck + build + test
```

## Layout

```
agent.yaml                     # descriptor (consumer trigger + init/revisit stages)
skills/
  code-it/SKILL.md             # implement → draft PR
  code-it-revisit/SKILL.md     # CI poll → flip / adapt / rollback / defer
src/
  payload.ts                   # per-stage payload types (+ revisit validator)
  request-schema.ts            # consumer request type + validator
  handler.ts                   # gates, skill selection, revisit loop
  agent.ts                     # defineAgent entry point
  lambda.ts                    # AWS Lambda cold-start wiring
  signing-key-resolver.ts      # ConsumerRecord signing key → HMAC bytes
test/                          # vitest specs
```
