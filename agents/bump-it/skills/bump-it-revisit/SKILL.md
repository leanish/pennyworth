---
name: bump-it-revisit
description: Follow up on a bump-it draft PR — flip it to ready when CI is green, adapt or roll back on failure, defer when pending.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  required: [repo, branch, alertRef, revisitCount]
  properties:
    repo:
      type: string
    branch:
      type: string
    alertRef:
      type: string
    revisitCount:
      type: number
outputSchema:
  type: object
  required: [outcome, ciConclusion]
  properties:
    outcome:
      type: string
      enum: [flipped, already-flipped, adapted, rolled-back, deferred]
    ciConclusion:
      type: string
      enum: [success, failure, pending, none]
    scheduleRevisit:
      type: object
      required: [afterSeconds]
      properties:
        afterSeconds:
          type: number
          minimum: 1
---

# bump-it-revisit

You follow up on a draft pull request that an earlier `bump-it` run opened for security alert `alertRef` on `repo`, branch `branch`. Read the PR's current state from GitHub, then pick exactly one outcome: **flip**, **already-flipped**, **adapt**, **roll back**, or **defer**. State lives entirely on GitHub — read it fresh; trust nothing carried over from earlier runs.

`GITHUB_TOKEN` is inherited in your environment; use the `gh` CLI (or direct GitHub API calls) for all reads and writes.

`revisitCount` is how many follow-ups this PR has already received. The cap is **2**: when `revisitCount` has reached 2, this is the final follow-up — do not request another, and prefer rolling back over adapting (an adaptation would never be checked again).

## Procedure

1. **Read the PR state first** (idempotency guard):
   `gh pr view <branch> --repo <repo> --json state,isDraft,number,url`
   - PR not found, closed, merged, or **no longer draft** → return `outcome: already-flipped` (report the `ciConclusion` you observed, or `none` if there was nothing to read). Do not touch anything.

2. **Read the CI conclusion** for the PR's head:
   `gh pr checks <branch> --repo <repo>` (or the checks API). Map what you see to one of:
   - `success` — all required checks passed;
   - `failure` — at least one check failed;
   - `pending` — checks are queued or running;
   - `none` — the project has no CI runs for this PR at all.

3. **Dispatch on the conclusion:**
   - **`success`** → flip the draft to ready-for-review: `gh pr ready <branch> --repo <repo>`. Return `outcome: flipped`. Never merge.
   - **`failure`** → inspect the failing run logs (`gh run view --log-failed` or equivalent) and the PR diff, then decide:
     - **Adapt** — only when the failure is clearly caused by the dependency bump and clearly fixable (e.g. a renamed API with an obvious replacement) **and** `revisitCount < 2`. Commit the minimal adapter change in the mounted working copy context or via the branch, push (no force-push), comment on the PR with what you changed and why. Return `outcome: adapted` and `scheduleRevisit: { "afterSeconds": 1800 }` so the new CI run gets checked.
     - **Roll back** — when the fix is not clearly adaptable, looks risky, or the cap is reached. Comment on the PR explaining why, close it (`gh pr close`), and delete the branch. Return `outcome: rolled-back`. The next scheduled scan will pick the alert up again with a clean slate.
   - **`pending`** → no code action. Return `outcome: deferred` and `scheduleRevisit: { "afterSeconds": 1800 }` so the run is re-checked once CI settles.
   - **`none`** → the project has no CI for this PR; there is nothing to verify automatically. Return `outcome: deferred` with **no** `scheduleRevisit` — the PR stays draft for a human to dispose of.

## Hard rules

- **Never merge a PR.**
- **Never force-push.**
- Be idempotent: re-running this skill against the same PR state must converge (the not-draft early-exit is the backstop).
- Only request `scheduleRevisit` when a later check can actually change the outcome (new CI run after adapt, or pending CI). The handler enforces the cap regardless.

## Output

End your response with a single fenced JSON block as the final non-whitespace content, matching the output schema. Examples:

CI green — flipped:

```json
{ "outcome": "flipped", "ciConclusion": "success" }
```

CI failed — adapted, re-check requested:

```json
{ "outcome": "adapted", "ciConclusion": "failure", "scheduleRevisit": { "afterSeconds": 1800 } }
```

CI pending — defer and re-check:

```json
{ "outcome": "deferred", "ciConclusion": "pending", "scheduleRevisit": { "afterSeconds": 1800 } }
```

PR already flipped or gone — idempotent no-op:

```json
{ "outcome": "already-flipped", "ciConclusion": "none" }
```
