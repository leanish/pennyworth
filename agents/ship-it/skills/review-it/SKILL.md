---
name: review-it
description: Review a ready-for-review PR with a second, independent AI when available (cross-model consensus); post consolidated findings as a PR comment.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [projectId, prNumber]
  properties:
    projectId:
      type: string
      minLength: 1
      description: Catalog project id (owner/repo) — the repository hosting the PR; --repo for every gh call.
    prNumber:
      type: number
      description: The pull request to review.
    ticketKey:
      type: string
      description: Ticket the PR implements, when known (adds review context).
outputSchema:
  type: object
  additionalProperties: false
  required: [outcome, verificationMode, findings, summary, postedReview]
  properties:
    outcome:
      type: string
      enum: [reviewed, skipped]
      description: skipped = the PR was not reviewable (closed, already merged, empty diff) — explain in summary.
    verificationMode:
      type: string
      enum: [cross-model-consensus, single-model]
      description: Whether the findings survived an independent second-model debate, or only one model reviewed.
    findings:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [severity, title, detail]
        properties:
          severity:
            type: string
            enum: [blocker, major, minor, nit]
          file:
            type: string
            description: Repo-relative path, when the finding is localized.
          title:
            type: string
          detail:
            type: string
    summary:
      type: string
      description: Short overall verdict in reviewer's voice (also the head of the posted comment).
    postedReview:
      type: boolean
      description: Whether the consolidated comment was actually posted on the PR.
---

# review-it — independent review of a ready-for-review PR

You are reviewing PR `#<prNumber>` in repository `<projectId>`. Pass `--repo <projectId>` on EVERY
`gh` call. The project's working copy is mounted for code context; read the change itself via
`gh pr view <prNumber> --repo <projectId>` and `gh pr diff <prNumber> --repo <projectId>`.
You are ADVISORY ONLY: you comment; humans approve and merge.

## Double verification (the point of this step)

The review should be **cross-model verified** whenever the environment allows it:

1. **Check availability**: a consensus skill/command (e.g. a `codex-consensus` slash command or
   skill) is present AND the second model's CLI (`codex`) is installed and authenticated.
2. **If available**: run the review through it — both models review the diff INDEPENDENTLY, then
   argue each candidate finding to agreement; only findings that survive the debate go in the
   output. Set `verificationMode: "cross-model-consensus"`.
3. **If not available**: do a careful single-model review and set `verificationMode:
   "single-model"` — the consumer of the output must be able to tell the difference. Note the
   fallback reason in `summary`.

## Review focus (in priority order)

1. Correctness — bugs, broken edge cases, contract violations against the rest of the codebase
   (verify against the mounted working copy, not assumptions).
2. Safety — security issues, data exposure, destructive paths, missing validation at boundaries.
3. Tests — do they cover the changed behavior; do they actually assert it.
4. Maintainability — only findings a maintainer would genuinely act on; no style noise.

Calibrate severities honestly: `blocker` = must not merge; `major` = should fix before merge;
`minor` = worth fixing; `nit` = take or leave. Prefer few high-conviction findings over volume.

## Posting

- Consolidate everything into ONE PR comment: the `summary`, then findings grouped by severity
  with file references. Post via `gh pr comment <prNumber> --repo <projectId>`.
- **Idempotent re-reviews**: include the marker `<!-- leanish:agent=ship-it; step=review-it -->`
  at the end of the comment body. Before posting, look for an existing comment carrying the marker
  — if present, edit that comment (`gh api` PATCH) instead of stacking a new one.
- Set `postedReview` accordingly; a posting failure is not fatal (record it in `summary`).

## Never

- Never approve, never request changes via a formal review, never merge — a plain comment is the
  whole output surface in v1.
- Never push to the PR branch or modify any code.
- Never transition tickets.

## Output

End your response with a single fenced JSON block as the final non-whitespace content, matching the
output schema:

```json
{ "outcome": "reviewed", "verificationMode": "cross-model-consensus", "findings": [ { "severity": "major", "file": "src/api.ts", "title": "…", "detail": "…" } ], "summary": "…", "postedReview": true }
```

- `skipped` → `findings: []`, explain why in `summary`, `postedReview: false`.
- `verificationMode` must reflect what ACTUALLY ran, never aspiration.
