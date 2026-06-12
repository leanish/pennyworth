# The fleet

One specialist per job. Each agent is its own deployable on the shared runtime; none calls another.
Posture legend: **reads** (touches nothing) · **advises** (recommends, mutates nothing) ·
**proposes** (opens draft PRs/comments; never merges, approves, deploys, or transitions final
state).

| Agent | Posture | Trigger | In one line |
|---|---|---|---|
| [ask-the-code](../agents/ask-the-code/README.md) | reads | a question (signed consumer message) | Plain-language answers about what the code *actually* does, grounded in the source. |
| [triage-it](../agents/triage-it/README.md) | advises | a request + curated evidence bundle | Correlates config, stats, and code into a diagnosis + suggested next steps. |
| [secure-it](../agents/secure-it/README.md) | proposes | recurring schedule | Keeps dependencies fresh and security alerts handled via one batched draft PR per project, revisited until CI is green. |
| [document-it](../agents/document-it/README.md) | proposes | recurring schedule | Audits docs against the code, classifies drift (stale / wrong / missing), batches fixes into one draft PR. |
| [ship-it](../agents/ship-it/README.md) | proposes | normalized ticket webhooks | Runs the matching `-it` skill for a ticket's workflow state — a person at every gate. |

## ask-the-code — *"what the code does, not what the docs claim"*

The read-only Q&A agent and the suite's pathfinder: it stood up the shared foundation and carries
the richest test ladder (unit → LocalStack integration → real-container Lambda rehearsal). Answers
arrive as terminal replies on the consumer's reply queue.

## triage-it — *"from a problem to a diagnosis"*

Advisory only: given a problem statement plus an evidence bundle (configuration, stats, code
excerpts), it returns a diagnosis with suggested next steps. It mutates nothing and triggers
nothing downstream — the requester decides what happens with the diagnosis.

## secure-it — *"staying current is staying secure"*

Scheduler-driven and strictly **opt-in** (`extensions["secure-it"].enabled === true` per project).
A tick fans out one worker per opted-in project; each runs a full dependency-freshness + CVE pass
and opens (or updates) **one batched draft PR per project** (branch `secure-it/dependency-refresh`,
per-advisory outcomes tracked in the output), then schedules delayed **revisits** that flip the PR
to ready-for-review when CI is green — or adapt, roll back, or defer (capped, so the loop
terminates). Never merges, never force-pushes.

## document-it — *"keeps the docs honest"*

Scheduler-driven, opt-in, same shape as secure-it. Each audit checks in-repo docs (README, `docs/`,
behavioral comments) against the code, classifies drift with confidence, and batches corrections
into one draft PR per project on a stable branch.

## ship-it — *"a person at every gate"* (+ its webhook gate)

Shepherds a ticket through its lifecycle by running the step that matches the ticket's workflow
state. The step registry rolls out one boolean at a time:

| Step | Status |
|---|---|
| groom-it (shape a raw ticket) | **released** |
| code-it (implement → draft PR) | implemented, **dark** |
| review-it (independent AI review) | implemented, **dark** |
| spec-it (iterate the spec) | implemented, **dark** |
| validate-it (did the deployed change work?) | implemented, **dark** |
| mock-it-up (design mockups) | future |

**[ship-it-normalizer](../agents/ship-it-normalizer/README.md)** is not an agent but the fleet's
**webhook gate**: a single Function-URL Lambda that verifies Jira/GitHub webhook signatures,
filters out everything irrelevant (the cost trick — non-matching events never start an agent),
normalizes the rest into signed `ship-it-event` envelopes, and sends them to ship-it's queue. To
the suite it is just another registered consumer.

## monitor-it — *"alerts → next step"* (future)

Designed, not yet built: turns an incoming alert into a triaged recommendation. Listed here so the
fleet table in people's heads matches the [presentation](presentation/index.html#4).
