---
name: code-it-revisit
description: Revisit a draft PR opened by code-it — read CI, then flip to ready, adapt, roll back, or defer.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [ticketKey, projectId, prNumber, branch, revisitCount]
  properties:
    ticketKey:
      type: string
      minLength: 1
      description: Ticket key the draft PR implements.
    projectId:
      type: string
      minLength: 1
      description: Catalog project id in owner/repo form — the GitHub repository hosting the PR.
    prNumber:
      type: number
      description: Draft PR number opened by code-it.
    branch:
      type: string
      minLength: 1
      description: PR head branch, e.g. ship-it/ABC-123.
    revisitCount:
      type: number
      minimum: 0
      description: How many revisits already ran for this PR. The cycle budget is 3 — at or near it, prefer settling over another adapt cycle.
outputSchema:
  type: object
  additionalProperties: false
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
      additionalProperties: false
      required: [afterSeconds]
      properties:
        afterSeconds:
          type: number
          minimum: 1
---

# code-it-revisit

You are revisiting draft PR `#<prNumber>` in repository `<projectId>` (branch `<branch>`) that an
earlier `code-it` run opened for ticket `<ticketKey>`. Read the PR's current state and CI
conclusion, then do exactly one of the actions below. Be idempotent — re-running against the same
state must be safe and must not repeat side effects.

## Inspect

Use `gh` (the environment inherits `GITHUB_TOKEN`). No working copy is mounted for a revisit, so
EVERY `gh` command must pass the repository explicitly via `--repo <projectId>`:

1. `gh pr view <prNumber> --repo <projectId>` — state, draft status, head branch.
2. `gh pr checks <prNumber> --repo <projectId>` — the CI conclusion for the head commit.

## Decide (first matching rule wins)

1. **PR is no longer a draft** (a human or an earlier revisit already flipped it, or it was merged
   or closed) → `outcome: "already-flipped"`. Touch nothing. Do not schedule another revisit.
2. **CI succeeded** → flip the PR to ready (`gh pr ready <prNumber> --repo <projectId>`) → `outcome: "flipped"`,
   `ciConclusion: "success"`. Best-effort: if a ticket CLI/API is available, comment on the ticket
   that the PR is ready for review (failure to comment is not fatal). Do not schedule another
   revisit.
3. **CI failed** → look at the failing checks:
   - If the failure is clearly fixable (a test your change broke, a lint error, a missing update),
     clone the repository first (`gh repo clone <projectId> -- --branch <branch> --depth 50` — no
     working copy is mounted for a revisit), fix it in the PR branch, run the affected tests
     locally, push (never force-push) →
     `outcome: "adapted"`, `ciConclusion: "failure"`, and request `scheduleRevisit:
     { "afterSeconds": 1800 }` so the new CI run gets checked. Consider `revisitCount`: at or near
     the budget of 3, do not start another speculative fix cycle.
   - If the failure is not clearly fixable (infrastructure flake you cannot retrigger, a deep design
     problem, repeated failed adapts) → close the PR and delete the branch (`gh pr close <prNumber>
     --repo <projectId> --delete-branch`) → `outcome: "rolled-back"`, `ciConclusion: "failure"`. Best-effort: comment
     on the ticket explaining the rollback. Do not schedule another revisit.
4. **CI still pending** → do nothing to the PR → `outcome: "deferred"`, `ciConclusion: "pending"`,
   and request `scheduleRevisit: { "afterSeconds": 1800 }`.
5. **No CI checks configured** → there is no signal to flip on; leave the draft for a human →
   `outcome: "deferred"`, `ciConclusion: "none"`. Do not schedule another revisit.

## Hard rules

- Never merge.
- Never force-push.
- Never transition the ticket's workflow state — express readiness only as a comment.

## Output

End your response with a single fenced JSON block as the final non-whitespace content:

```json
{ "outcome": "deferred", "ciConclusion": "pending", "scheduleRevisit": { "afterSeconds": 1800 } }
```

Omit `scheduleRevisit` entirely when no further revisit is needed.
