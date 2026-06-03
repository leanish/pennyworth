---
name: codex-consensus
description: >-
  Adversarial validation loop between Claude and Codex (the OpenAI CLI): both
  independently review a change, plan, or set of findings, argue each item, and
  iterate on ONE persistent Codex session until they settle (or hit the round
  cap); then changes are implemented and the implementation is debated the same
  way. Trigger when the user wants Claude and Codex to reach AGREEMENT — i.e.
  they name Codex alongside a consensus/cross-check intent: "agree with Codex",
  "settle this with Codex", "reach consensus with Codex",
  "double-check/cross-check this with Codex", "validate this with Codex",
  "have Codex weigh in and agree" — or they run the /codex-consensus command. Do NOT trigger on
  generic requests that lack this Codex-agreement intent: a plain "review this",
  "is this correct?", or "get a second opinion" with no mention of Codex or
  reaching consensus is NOT enough. Mode: Claude implements by default; Codex
  implements when told to "make Codex" do it.
---

# Codex Consensus

Pair with Codex as an independent second brain. The two of you critique each
other's findings, argue each one, and **settle** on the set worth acting on —
then implement and review the result the same way. One Codex session spans the
whole task, so Codex never forgets what was already argued.

## The one rule that makes this work

Every Codex turn for a given task goes through the wrapper with the **same
`<label>`**. Same label = same Codex session (memory preserved). Pick a unique,
descriptive label per task (e.g. `auth-refactor`). Different tasks → different
labels → no cross-contamination, even in parallel.

```
# <absolute path to this skill> = the "Base directory for this skill:" path shown when this skill is invoked
SCRIPT=<absolute path to this skill>/scripts/codex-converse.mjs
# message via a temp file (best for multi-paragraph content):
node "$SCRIPT" auth-refactor --prompt-file /tmp/msg.md
# or inline:
node "$SCRIPT" auth-refactor --message "..."
```
stdout = Codex's reply (clean). stderr = `label / action / thread / round`.
Helpers: `--show <label>`, `--list`, `--reset <label>`.

## Set the sandbox at session start (it's locked after)

Decide **who implements** before the first Codex call — the sandbox can't change
on resume:

- **Claude implements** (default; Codex only ever reviews) → first call uses
  `--sandbox read-only` (also the wrapper default). Codex cannot touch files.
- **Codex implements** ("make Codex handle it") → first call must pass
  `--sandbox workspace-write` explicitly.

## Workflow

Announce the mode and label, then run two debates back-to-back. Narrate every
round so the user sees the steps (keep it skimmable).

### Phase 1 — Debate the review / plan
1. **Claude produces first.** Do your own review (or plan) and write the findings
   to a temp file, each as a numbered item with a clear claim + rationale + a
   `worth-handling: yes/no` stance.
2. **Hand it to Codex.** Send that file. Ask Codex to do its *own independent*
   pass: for each of your items state agree / disagree **with reasoning**, add
   anything you missed, and judge what is worth handling. Tell it **not to edit
   files** in this phase.
3. **Run the settle loop** (below) over the findings until you agree on the final
   set worth handling.

### Phase 2 — Implement the agreed set
- **Claude implements:** make the changes for the settled items (follow repo
  norms / TDD).
- **Codex implements:** ask the same session to implement the settled items.

### Phase 3 — Debate the implementation
- Send the diff to the same session (whoever did *not* write it reviews it; the
  reviewer can run `git diff` itself). Run the settle loop again until you agree
  the change is correct. Codex revises in-session, or Claude addresses/rebuts.

When both debates have settled, report the outcome: what was handled, what was
agreed to skip and why, and anything left unresolved.

## The settle loop

Track each item as **agreed-handle**, **agreed-skip**, or **open**. Repeat:
1. Read the other side's points. For each: **concede** (they convinced you) or
   **rebut** (state why). Only discuss open or newly-raised items — don't
   re-litigate settled ones.
2. Send concessions + rebuttals back through the same label.
3. **Settled** when no open items remain. **Stop early** if the same arguments
   repeat (you're circling) — mark those items unresolved.

- **Round cap: 5 per debate** (Phase 1 and Phase 3 are capped separately).
  Extend to **10** only if points are genuinely still converging. Count rounds
  yourself — the wrapper's `round=N` is *total* calls for the label across both
  phases, not a per-debate counter.
- On cap or circling, make the final call yourself and surface the disagreement
  to the user; don't pretend consensus you didn't reach.

## If a round fails (quota, network, crash)

A failed call exits non-zero with the real reason (e.g. *"out of credits"*) and a
`[trace: …]` path; the wrapper writes **no state** on failure, so nothing is
corrupted and no round is counted.

- **Stop — don't fabricate a settled round.** Report the exact error to the user.
- **A resume is recoverable.** If the label already existed, it still points at
  the same Codex thread, so once the cause is resolved, re-issue the *same* round:
  it resumes that thread with full memory and continues where it stalled.
- **A failed first call records nothing**, so just retry it — that starts a fresh
  session (the orphaned Codex-side thread is harmless).
- Don't auto-retry a quota/credit failure — wait for the user to resolve it.

## Notes
- Long messages → always `--prompt-file` (avoids shell-escaping pain).
- **One in-flight call per label.** Distinct labels may run concurrently (that's
  how parallel debates stay isolated); same-label calls must be sequential — send
  round N+1 only after round N returns.
- Effort defaults to `xhigh`. Override with `--effort` on the **first** call
  (locked after).
- The stderr header reports per-turn token usage; every call's raw JSONL is saved
  to `~/.claude/codex-converse/logs/`. Add `--trace` to echo the full event
  stream inline (useful for diagnosing errors like quota/credit failures).
- See [EXAMPLES.md](EXAMPLES.md) for both modes worked end-to-end.
