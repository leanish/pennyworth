---
name: verify-docs
description: Audit one project's documentation against its actual code, classify drift (stale / wrong / missing), batch in-repo corrections into one draft PR, and surface published-page suggestions in the output.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [project, docSet]
  properties:
    project:
      type: object
      additionalProperties: false
      required: [id, source]
      properties:
        id:
          type: string
          minLength: 1
          description: Catalog project id, e.g. "leanish/foo".
        source:
          type: object
          additionalProperties: false
          required: [url]
          properties:
            url:
              type: string
              minLength: 1
              description: Git remote URL of the project.
            branch:
              type: string
              description: Default branch the working copy is synced to.
    docSet:
      type: object
      additionalProperties: false
      description: Which published pages belong to this project. May be empty — then audit in-repo docs only.
      properties:
        space:
          type: string
          description: Published-docs space key the project documents live in.
        pageIds:
          type: array
          items:
            type: string
          description: Explicit published page ids in scope.
        labels:
          type: array
          items:
            type: string
          description: Page labels that select published pages in scope.
outputSchema:
  type: object
  additionalProperties: false
  required: [summary, inRepoDrift, publishedDrift]
  properties:
    summary:
      type: string
      minLength: 1
      maxLength: 4096
      description: Short human-readable recap of the audit (what was checked, what drifted, what was proposed).
    inRepoDrift:
      type: array
      description: Drift found in docs that live in the repository. Empty when the docs match the code.
      items:
        type: object
        additionalProperties: false
        required: [type, location, claim, correction, confidence]
        properties:
          type:
            type: string
            enum: [stale, wrong, missing]
          location:
            type: string
            description: File path (and heading/line hint) of the drifted claim, e.g. "README.md#configuration".
          claim:
            type: string
            description: What the doc currently says (or fails to say, for `missing`).
          correction:
            type: string
            description: The corrected text proposed in the draft PR.
          confidence:
            type: number
            minimum: 0
            maximum: 1
            description: How sure the audit is that this is real drift (1 = certain).
    publishedDrift:
      type: array
      description: Drift found on published pages identified by `docSet`. Suggestions only — nothing is posted anywhere.
      items:
        type: object
        additionalProperties: false
        required: [type, location, claim, suggestion, confidence]
        properties:
          type:
            type: string
            enum: [stale, wrong, missing]
          location:
            type: string
            description: Published-page reference (space/pageId or page title plus section).
          claim:
            type: string
            description: What the published page currently says (or fails to say, for `missing`).
          suggestion:
            type: string
            description: The proposed replacement or addition, ready for a human to apply.
          confidence:
            type: number
            minimum: 0
            maximum: 1
    pullRequest:
      type: object
      additionalProperties: false
      required: [url, branch]
      description: Present when in-repo corrections were batched into a draft PR.
      properties:
        url:
          type: string
        branch:
          type: string
---

# verify-docs

You audit one project's documentation against its actual code and propose corrections. The project's
working copy is mounted in your working set; `project` tells you which one and `docSet` tells you
which published pages (if any) belong to it.

Your goal is **accuracy only**: find statements that are **stale** (were true, no longer), **wrong**
(never true), or **missing** (the code does something important the docs don't cover). Do NOT
restyle, reformat, or rewrite prose that is already accurate — cosmetic changes are out of scope,
even when tempting.

## What counts as a doc

Audit, in priority order:

1. `README.md` (and any `README` variants at the repo root or in subpackages).
2. Files under `docs/` (guides, how-tos, architecture notes).
3. Code comments and docstrings that make **behavioral claims** (e.g. "retries 5 times",
   "defaults to `catalog.json`") — not stylistic or TODO comments.

For each claim, verify it against the code itself: read the implementation, configuration defaults,
CLI flags, exported APIs. Cite the doc location precisely in `location` (file path plus a
heading/line hint). Set `confidence` honestly — 1.0 only when the code is unambiguous; lower it when
behavior depends on runtime data you cannot observe.

## In-repo corrections → one draft PR

Batch ALL in-repo corrections for this project into **one** pull request using the `gh` CLI (the
`GITHUB_TOKEN` in your environment is already authorized):

- Branch: `document-it/docs-drift` (stable name — one branch per project, reused across audit runs).
- The PR must be a **draft**, labeled `leanish:agent:document-it`.
- **Idempotent**: before creating anything, check for an existing open PR from
  `document-it/docs-drift`. If one exists, update that branch (commit on top or amend the tree to the
  new corrected state) and leave the PR open — do NOT open a second PR.
- Commit only doc corrections drawn from your `inRepoDrift` findings. If there are no in-repo
  findings, do not create a branch or PR, and omit `pullRequest` from the output.
- **Never merge. Never force-push.** A human reviews and applies everything.

## Published pages → suggestions in the output only

For pages identified by `docSet` (space / pageIds / labels), produce your proposed corrections as
`publishedDrift` entries in the output. **Do not attempt to post, comment, or write to any external
system** — the delivery channel for published-page suggestions is handled outside this skill. Each
`suggestion` should be ready for a human to paste in: complete, self-contained corrected text.

If `docSet` is empty (no space, no pageIds, no labels), return an empty `publishedDrift` array and
audit in-repo docs only.

## Output

End your response with a single fenced JSON block as the final non-whitespace content:

```json
{
  "summary": "Audited README.md and docs/ against the code; 2 stale claims corrected in a draft PR.",
  "inRepoDrift": [],
  "publishedDrift": []
}
```

The runtime parses only that final block; anything before it (reasoning, shell transcripts) is
allowed, anything after it is an invocation failure. Include `pullRequest` (with `url` and `branch`)
only when you actually opened or updated a draft PR.
