# AGENTS.md

## What this repo is

- **claude-parley** — the implementation of `parley`, a local CLI harness that runs two coding
  agents (Codex, Claude Code) against the same task in a bounded, alternating **relay** and
  escalates to the human when they cannot converge.
- A standalone developer tool: no AWS, no descriptor, **no dependency** on `agent-runtime`,
  `catalogit`, or `agent-infra`. It drives the local `codex` / `claude` CLIs via subprocess; it never
  calls a model API directly and never parses or edits source files itself.
- This repo must stand on its own; do not reference private specs from any checked-in file.

## Working rules

- **Vocabulary:** parley orchestrates **coding agents** (two words). The bare word "agent" is avoided
  for `codex` / `claude` and for parley itself.
- **Spelling:** `parley`, never `parlay`. Verdict fields are lowercase (`status`, `summary`,
  `reason`, `body`).
- **Slots are fixed:** agent-1 opens and is always read-only; agent-2 responds, is the actor only
  when prompt-2 is present, and runs the finalizer. Only the CLI⇄slot mapping is configurable
  (`--first`).
- **Two flows:** read-only (no prompt-2) — both deliberate; action (prompt-2) — agent-1 reviews,
  agent-2 acts on the agreed parts. Only agent-2 writes, only in the action flow.
- **`status` is control flow:** `continue` = keep going; `done` = nothing material remains.
- **Non-interactive:** never block on stdin; escalation is an exit plus a continuation command.
- **Thin footprint:** TS/Node ≥ 24, `commander` for args, `node:child_process` for subprocesses,
  `vitest` for tests. Nothing speculative. Employer-neutral.

## Code map

- `src/cli.ts` — arg parsing (`commander`), validation (incl. both-or-neither resume), exit codes.
- `src/bin/parley.ts` — thin executable entry.
- `src/parley.ts` — the interleaved relay loop + finalizer.
- `src/plan.ts` — `--first` + session ids → slot assignment.
- `src/agents/` — `AgentRunner` interface, `ClaudeRunner`, `CodexRunner`, `spawn`, `verdict-schema`
  (incl. the prose-fallback `extractVerdictFromText`).
- `src/prompts/build-prompt.ts` — the read-only / action turn prompts + the finalizer prompt.
- `src/output/` — text (stdout) and JSON (`--output` / `--steps-output`) renderers.
- `src/types.ts` — verdict, step, outcome types.

## Behavior to preserve

- One round = agent-1 turn + agent-2 turn; `--rounds` (default 5) caps rounds.
- Settle on the responding turn's `done` (the opener cannot settle); then run the read-only
  finalizer on agent-2 — its body is `final.result`. `needs-user` (any turn) escalates; `error` /
  invocation failure ⇒ `failed`; exhausting `--rounds` ⇒ `exhausted`.
- Exit codes: `0` settled, `1` usage, `2` exhausted, `3` needs-user, `4` failed.
- Claude id self-assigned (`--session-id <uuid>`); Codex id captured from `thread.started`; failure
  to capture it is fatal. Resume is both-or-neither.
- Continuation (both session ids; `--first` only when non-default) printed on `exhausted` /
  `needs-user` only.
- Verdict extraction: Codex = `--output-last-message` JSON; Claude = top-level `structured_output`,
  falling back to a fenced ```json block (observed on Claude Code 2.1.158: `--resume` turns that use
  tools omit `structured_output`; may vary by version, so the `ClaudeRunner` appends the verdict-block
  instruction to every prompt and the fallback is always on).

## Verification

- `npm run check` = typecheck (`tsc -b` + test config) + build + `vitest run`.
- Unit tests use **mock** `AgentRunner`s — real `codex` / `claude` are never required.
- The phase-1 acceptance gate (an agent edits files **and** returns a conforming verdict in one
  invocation) lives as a skipped integration test in `test/acceptance.integration.test.ts`; run it
  deliberately against a disposable git working tree.

## Phasing

- **Phase 1**: no permission/sandbox injection — inherit the operator's CLI config; agent-1's
  read-only behavior is prompt-advisory. Both-or-neither resume. The action opener assumes existing
  state to review (fits review/assess; create-from-nothing is a later refinement).
- **Phase 2**: structural permission enforcement (read-only sandbox for agent-1; scoped write for
  agent-2 in the action flow), and the broader out-of-scope list in the spec.
