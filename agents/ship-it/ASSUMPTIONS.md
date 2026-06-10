# ship-it — assumptions (phase 1)

Decisions taken while building the phase-1 `code-it` slice that are not (yet) backed by a deployed
counterpart, plus the trust acknowledgments an operator should know about.

## 1. Consumer-envelope stand-in for the future webhook normalizer

The producer of ship-it's input is a **webhook normalizer** that does not exist yet. Phase 1 treats
it as just another registered consumer: it signs envelopes of kind **`ship-it-event`** whose inner
payload carries the ticket content (`ticketKey`, `projectId`, `ticketStatus`, `labels`,
`ticketSummary`, `ticketDescription?`, `acceptanceCriteria?`). Because the payload carries the
ticket content, the handler performs **no Jira fetch in v1** — what the normalizer sends is what
code-it implements. When the normalizer lands, it registers in the ConsumerRegistry like any other
consumer; nothing in this package changes.

## 2. The `ship-it` ticket-label gate is re-asserted in-handler

The normalizer is specified to emit a message only when the ticket carries the `ship-it` label, so
the in-handler check on `request.labels` is defense in depth. A message without the label is logged
and skipped, not failed.

## 3. `statusSkillMap`, the step registry, and later phases

The ticket status → step mapping defaults to `{"Ready for Implementation": "code-it"}` and can be
overridden per project via `extensions.ship-it.statusSkillMap` (an override **replaces** the
default, no merge). Every step the lifecycle can route to lives in the **step registry**
(`src/steps.ts`) with a per-step `released` switch: steps are developed and merged dark
(`released: false`) and launched by flipping one boolean. A status mapped to a dark or unknown step
is logged and skipped — never failed. A registry test pins that every released step is a declared
skill entrypoint, so a step can't be flipped live without its skill shipping with it.

## 4. The `code-it-revisit` contract is defined here

Earlier design notes sketched the revisit loop but did not pin its contract; this package defines
it: output `{outcome: flipped | already-flipped | adapted | rolled-back | deferred, ciConclusion:
success | failure | pending | none, scheduleRevisit?: {afterSeconds}}`, a **cycle budget of 3**
(a revisit arriving with `revisitCount >= 3` never reschedules), a first revisit **3600 s** after
the draft PR opens, and **1800 s** between subsequent polls.

## 5. `allowUnsignedRuntimeMessagesWithConsumerTrigger: true`

ship-it declares a `signedEnvelope` consumer trigger AND receives its own unsigned self-published
`revisit` runtime messages on the same queue. The runtime's shim rejects that mix by default (a
consumer holding SendMessage could otherwise craft a runtime-message-shaped body and bypass HMAC
verification). The Lambda entry sets the explicit acknowledgment because the queue's SendMessage
grants are limited to two trusted internal principals: the webhook normalizer and the agent's own
EventBridge Scheduler role. If that grant set ever widens, this acknowledgment must be revisited.

## 6. Ticket comments are best-effort; deploy wiring deferred

Both skills comment back on the ticket (PR link, ready-for-review, rollback explanation) only when
ticket tooling is available in the execution environment, and a comment failure never fails the
run — it is recorded in the skill's notes. Provisioning (queue, DLQ, schedule group, normalizer
registration, image build) is deferred; `infra/src/registry.ts` carries the registration entry so
the deploy roster already knows about ship-it.
