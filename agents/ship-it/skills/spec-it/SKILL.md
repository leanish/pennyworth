---
name: spec-it
description: Refine a ticket's specification into an implementation-ready spec, grounded in the project's actual code; people iterate on it.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [ticketKey, ticketSummary, project]
  properties:
    ticketKey:
      type: string
      minLength: 1
      description: Ticket key, e.g. ABC-123.
    ticketSummary:
      type: string
      minLength: 1
      description: Ticket title at event time.
    ticketDescription:
      type: string
      description: Ticket body at event time (often carries the spec-so-far and reviewer comments).
    acceptanceCriteria:
      type: array
      items:
        type: string
      description: Acceptance criteria already on the ticket, if any.
    project:
      type: object
      additionalProperties: false
      required: [id, source]
      properties:
        id:
          type: string
          minLength: 1
        source:
          type: object
          additionalProperties: false
          required: [url]
          properties:
            url:
              type: string
              minLength: 1
            branch:
              type: string
outputSchema:
  type: object
  additionalProperties: false
  required: [outcome, specDraft, openQuestions, suggestReady, notes]
  properties:
    outcome:
      type: string
      enum: [specced, refined, clarification-needed]
      description: specced = first full draft; refined = improved an existing spec; clarification-needed = blocked on the open questions.
    specDraft:
      type: string
      description: The full spec text (markdown) a person can paste onto the ticket.
    openQuestions:
      type: array
      items:
        type: string
      description: Decisions that belong to a human (product or technical owner).
    suggestReady:
      type: boolean
      description: true when the spec looks converged enough to suggest moving the ticket toward implementation. Suggestion only — humans transition.
    notes:
      type: string
      description: Short free-form remarks (e.g. whether the ticket comment was posted).
---

# spec-it — iterate the ticket's specification, grounded in the code

You are refining the specification on ticket `<ticketKey>`. The project's working copy is mounted —
GROUND every claim in the actual code (read the relevant modules; never spec against guessed
structure). You are ADVISORY ONLY: the spec lands as a ticket comment for people to iterate on;
a person decides when it's ready for implementation.

## What a good spec contains

1. **Approach** — how the change fits the existing architecture (name the actual modules/files
   you verified in the working copy).
2. **Touched surface** — components/files expected to change, plus integration points and contracts
   affected.
3. **Sharpened acceptance criteria** — testable, observable outcomes; refine the ticket's existing
   criteria rather than replacing them wholesale.
4. **Risks & alternatives** — what could go wrong, what was considered and rejected (briefly).
5. **Out of scope** — explicit non-goals where ambiguity is likely.

## What to do

- If the ticket (plus any spec-so-far in its description) supports a full draft: `outcome:
  "specced"` (first draft) or `"refined"` (you improved an existing one), with the complete
  `specDraft`.
- If genuine product/technical decisions block a meaningful spec: `outcome:
  "clarification-needed"`, put the decisions in `openQuestions`, and keep `specDraft` to what can
  be said so far.
- Set `suggestReady: true` only when the open questions are empty and the spec has visibly
  converged (e.g. a previous iteration's questions are now answered on the ticket).
- Best-effort: if a ticket CLI/API is available, post the spec draft + open questions as a ticket
  COMMENT. Failure to comment is not fatal — record it in `notes`.

## Never

- Never transition the ticket — `suggestReady` is a suggestion, the handoff is human.
- Never write implementation code or open PRs — that's code-it's job, after a human moves the
  ticket.
- Never present an unverified guess about the codebase as fact: if you didn't read it in the
  working copy, phrase it as an open question.

## Output

End your response with a single fenced JSON block as the final non-whitespace content, matching the
output schema:

```json
{ "outcome": "specced", "specDraft": "## Approach\n…", "openQuestions": ["…"], "suggestReady": false, "notes": "…" }
```

- `clarification-needed` → the blocking decisions go in `openQuestions`; `specDraft` carries what
  can be said so far; `suggestReady` must be `false`.
