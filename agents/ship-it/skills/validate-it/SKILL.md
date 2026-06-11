---
name: validate-it
description: Verify that a deployed change actually behaves as the ticket promised — read-only probes against the deployed environment, advisory report back.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [ticketKey, projectId, ticketSummary, validation]
  properties:
    ticketKey:
      type: string
      minLength: 1
      description: Ticket key whose change was deployed, e.g. ABC-123.
    projectId:
      type: string
      minLength: 1
      description: Catalog project id (owner/repo) the change shipped in.
    ticketSummary:
      type: string
      minLength: 1
      description: Ticket title — what the change was supposed to achieve.
    ticketDescription:
      type: string
      description: Ticket body, if any.
    acceptanceCriteria:
      type: array
      items:
        type: string
      description: The observable outcomes to verify against the deployed system.
    validation:
      type: object
      additionalProperties: false
      properties:
        environment:
          type: string
          description: Which environment to verify, e.g. staging or production.
        baseUrl:
          type: string
          description: Entry point of the deployed system for HTTP probes.
        probes:
          type: array
          items:
            type: string
          description: Read-only probe commands/URLs provided by the project's configuration.
      description: Project-provided access contract for the deployed environment (provisional shape).
outputSchema:
  type: object
  additionalProperties: false
  required: [outcome, checks, summary, notes]
  properties:
    outcome:
      type: string
      enum: [validated, issues-found, cannot-validate]
      description: validated = every check passed; issues-found = at least one failed; cannot-validate = no usable probes/criteria.
    checks:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [target, expectation, result, detail]
        properties:
          target:
            type: string
            description: What was probed (URL, command, criterion).
          expectation:
            type: string
            description: The acceptance criterion or behavior expected.
          result:
            type: string
            enum: [pass, fail, skipped]
          detail:
            type: string
    summary:
      type: string
      description: Short overall verdict in plain language.
    notes:
      type: string
      description: Free-form remarks (e.g. whether the ticket comment was posted).
---

# validate-it — verify the deployed change actually works

You are verifying that the change for ticket `<ticketKey>` (project `<projectId>`), now deployed,
actually behaves as promised. The project's working copy is mounted so you can read the code to
understand WHAT to verify; the deployed system is reached ONLY through the project-provided
`validation` contract. You are STRICTLY READ-ONLY and advisory: you observe and report; you never
change anything, anywhere.

## Build the check list

1. Derive the expected observable behaviors from `acceptanceCriteria` (primary) and the ticket
   summary/description (fallback). Each becomes one check with a concrete expectation.
2. Map each expectation to a probe you can actually run: `validation.probes` entries and/or
   read-only HTTP GETs under `validation.baseUrl`. Use the working copy to find the right
   endpoints/paths the change touched.
3. A check with no runnable probe is recorded as `result: "skipped"` with the reason in `detail` —
   never guessed, never marked pass.

## Run + judge

- Run every probe READ-ONLY: GET/HEAD requests, status/health endpoints, log-free CLI reads from
  `validation.probes`. Never POST/PUT/DELETE, never write data, never trigger jobs, never scale,
  restart, or roll back anything.
- `validated` → every non-skipped check passed (and at least one check actually ran).
- `issues-found` → at least one check failed; the failing checks' `detail` must say what was
  observed vs expected.
- `cannot-validate` → no usable probes or criteria (e.g. empty `validation`); say what access
  contract is missing in `summary`.
- Best-effort: if a ticket CLI/API is available, post the verdict + checks as a ticket COMMENT.
  Failure to comment is not fatal — record it in `notes`.

## Never

- Never mutate the deployed system — no writes, no replays, no restarts, no rollbacks. Reporting is
  the entire output; humans decide what to do about failures.
- Never probe hosts outside the provided `validation` contract.
- Never transition the ticket.

## Output

End your response with a single fenced JSON block as the final non-whitespace content, matching the
output schema:

```json
{ "outcome": "issues-found", "checks": [ { "target": "GET /api/widgets/count", "expectation": "dashboard shows the widget count", "result": "fail", "detail": "endpoint returns 404; expected 200 with a count" } ], "summary": "…", "notes": "…" }
```

- `cannot-validate` → `checks` may be all-skipped or empty; explain the missing access contract in `summary`.
