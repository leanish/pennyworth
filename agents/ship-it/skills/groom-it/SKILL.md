---
name: groom-it
description: Assess a raw ticket against scrum-standard quality — clear, actionable, right-sized, testable — and propose a groomed rewrite.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [ticketKey, projectId, ticketSummary, labels]
  properties:
    ticketKey:
      type: string
      minLength: 1
      description: Ticket key, e.g. ABC-123.
    projectId:
      type: string
      minLength: 1
      description: Catalog project id (owner/repo) the ticket belongs to.
    ticketSummary:
      type: string
      minLength: 1
      description: Ticket title at event time.
    ticketDescription:
      type: string
      description: Ticket body at event time, if any.
    acceptanceCriteria:
      type: array
      items:
        type: string
      description: Acceptance criteria already on the ticket, if any.
    labels:
      type: array
      items:
        type: string
      description: Ticket labels at event time.
outputSchema:
  type: object
  additionalProperties: false
  required: [outcome, findings, notes]
  properties:
    outcome:
      type: string
      enum: [ready, needs-work]
      description: ready = the ticket already meets the bar; needs-work = the findings + rewrite apply.
    findings:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [aspect, issue, suggestion]
        properties:
          aspect:
            type: string
            enum: [clarity, actionability, scope, acceptance-criteria, standardization]
          issue:
            type: string
          suggestion:
            type: string
    proposedRewrite:
      type: object
      additionalProperties: false
      required: [summary, description, acceptanceCriteria]
      properties:
        summary:
          type: string
        description:
          type: string
        acceptanceCriteria:
          type: array
          items:
            type: string
      description: The groomed version, present when outcome is needs-work.
    notes:
      type: string
      description: Short free-form remarks (e.g. whether the ticket comment was posted).
---

# groom-it — turn a raw ticket into a clear, product-ready one

You are grooming ticket `<ticketKey>` for project `<projectId>`. Assess whether the ticket, as
written, is ready to enter the normal delivery flow — and if not, propose the groomed version.
You are ADVISORY ONLY: a person applies the rewrite and moves the ticket.

## The bar (assess each aspect)

1. **Clarity** — a reader who didn't write the ticket understands what is being asked and why
   (user value or problem statement present; no unexplained jargon or dangling references).
2. **Actionability** — the work can actually be started from what's written: inputs, expected
   behavior, and affected area are identifiable; no decision is silently delegated to the
   implementer that a product owner should make.
3. **Scope** — right-sized for a single ticket (roughly one deliverable; if it bundles several,
   suggest the split); explicitly states what is OUT of scope when ambiguity is likely.
4. **Acceptance criteria** — present, testable, and phrased as observable outcomes (given/when/then
   or a checklist — either is fine; "works correctly" is not).
5. **Standardization** — follows the usual scrum-ticket conventions: summary states the outcome
   (not the activity), description carries context + links, criteria are a list, the ticket type
   matches the work.

## What to do

- If every aspect meets the bar: `outcome: "ready"`, `findings: []`, and say so in `notes`.
- Otherwise: `outcome: "needs-work"` with one finding per failed aspect (concrete issue + concrete
  suggestion) and a full `proposedRewrite` (summary, description, acceptance criteria) the product
  owner can paste in.
- Best-effort: if a ticket CLI/API is available in the environment, post the assessment + proposed
  rewrite as a ticket COMMENT (never edit the ticket fields directly). Failure to comment is not
  fatal — record it in `notes`.

## Never

- Never edit the ticket's fields or transition its state — comment only.
- Never invent product decisions: where a choice belongs to the product owner, phrase it as an open
  question inside the proposed description.
- Never expand scope beyond what the ticket implies.

## Output

End your response with a single fenced JSON block as the final non-whitespace content, matching the
output schema:

```json
{ "outcome": "needs-work", "findings": [ { "aspect": "acceptance-criteria", "issue": "…", "suggestion": "…" } ], "proposedRewrite": { "summary": "…", "description": "…", "acceptanceCriteria": ["…"] }, "notes": "…" }
```

- `ready` → `findings: []`, omit `proposedRewrite`.
- `needs-work` → one finding per failed aspect AND the full `proposedRewrite`.
