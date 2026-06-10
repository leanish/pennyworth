# `@leanish/ship-it`

Ticket-lifecycle Layer-3 agent: shepherds a ticket through its workflow states by running the
matching `-it` skill for each state, with a person at every gate. It never merges, deploys, or
transitions a ticket — it proposes (draft PRs, comments) and humans decide.

Built on `@leanish/runtime`. See `1-pager.md` for the plain-language overview and
`ASSUMPTIONS.md` for the phase-1 decisions.

## Status — phase 1: `code-it`

Implemented in this package today:

- **`code-it`** — a ticket a human moved to *Ready for Implementation* (and labelled `ship-it`, on
  an opted-in project) gets implemented in the project working copy, tested with the project's own
  suite, and opened as a **draft PR**.
- **`code-it-revisit`** — a self-scheduled loop (runtime `publishDelayed`, bounded at 3 cycles)
  polls CI on the draft PR: green → flip to ready-for-review; red → fix and push, or close the PR
  and delete the branch; pending → poll again.

Later steps behind the same status → skill map (not in this package yet):

- **`review-it`** (phase 2) — independent cross-model PR review.
- **`spec-it`** (phase 3) — iterate the spec on the ticket.
- **`groom-it`**, **`mock-it-up`**, **`validate-it`** — future.

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
