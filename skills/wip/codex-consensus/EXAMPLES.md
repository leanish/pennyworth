# Codex Consensus — worked examples

`SCRIPT=<absolute path to this skill>/scripts/codex-converse.mjs` — replace the
placeholder with this skill's base directory (the path shown on invocation).

Both examples use one label for the whole task, so Codex remembers every round.

---

## Example A — "review this code, handle the findings if they're worth handling"

**Claude implements.** Codex only ever reviews → start the session read-only.

**Phase 1 — debate the review**

1. Claude reviews the diff and writes findings to a temp file:

   ```
   # /tmp/cc-payments-review.md
   1. [worth-handling: yes] `refundOrder` swallows the gateway error — a failed
      refund looks successful to the caller. Wrap and rethrow with context.
   2. [worth-handling: yes] N+1: `loadLineItems` queries per item in a loop.
   3. [worth-handling: no] Rename `tmp` to `pending` — cosmetic, skip.
   ```

2. Hand it to Codex (first call → read-only locks the session):

   ```
   node "$SCRIPT" payments-review --sandbox read-only --prompt-file /tmp/cc-msg.md
   ```
   where `/tmp/cc-msg.md` asks: *"Here is my review of the payments change (see
   /tmp/cc-payments-review.md, and `git diff` for the code). Do your own pass.
   For each item: agree or disagree with reasoning. Add anything I missed. Judge
   what's truly worth handling. Do not edit any files."*

3. Settle loop — narrate each round:

   > **Round 1 (review)** — Codex agrees on #1 and #2. Disagrees on dropping #3
   > (minor but trivial, says keep). Raises #4: missing idempotency key lets a
   > retried refund double-pay — worth handling.
   >
   > **My response:** Concede #4 (real, important). Concede #3 (cheap, fine to
   > keep). #1, #2 already agreed.

   No open items → **settled** after round 1. Agreed set: #1, #2, #3, #4.

**Phase 2 — Claude implements** items #1–#4 (TDD per repo norms).

**Phase 3 — debate the implementation** (same label = same session):

```
node "$SCRIPT" payments-review --prompt-file /tmp/cc-msg2.md
```
*"I implemented the four items. Review the change (`git diff`). Flag anything
wrong."*

> **Round 1 (code review)** — Codex: idempotency key isn't covered by a test.
> **My response:** Agree — adding the test.
>
> **Round 2 (code review)** — Codex: looks correct. **Settled.**

Report: handled #1–#4 (incl. the idempotency fix Codex surfaced), kept #3,
nothing unresolved.

---

## Example B — "review this code, make Codex handle the findings"

Identical Phase 1 **except** the session starts writable, because Codex
implements:

```
node "$SCRIPT" payments-review --sandbox workspace-write --prompt-file /tmp/cc-msg.md
```

**Phase 2 — Codex implements** (same session):

```
node "$SCRIPT" payments-review --message "We settled on items #1, #2, #4 (keep #3 as-is). Implement them now. Run the tests."
```

**Phase 3 — Claude reviews Codex's diff**, then debates in-session:

> **Round 1 (code review)** — I reviewed Codex's `git diff`. #2's batch query
> drops the ordering the caller relies on.
> Sent back: *"Line items must stay ordered by `position`; your batch query
> loses it."*
>
> **Round 2** — Codex restored the ordering. I re-checked: correct. **Settled.**

Report the same way.

---

## If they don't settle

Hit round 5 (or 10 for genuinely hard points) and still split, or the same
arguments keep repeating → stop, make the call yourself, and tell the user
exactly where you and Codex disagreed and why you chose as you did. Never claim
consensus you didn't reach.
