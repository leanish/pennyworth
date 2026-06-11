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
and skipped, not failed. *(Owner-confirmed.)* Owner note folded in: a ticket comment mentioning
`@ship-it` (or similar) is an accepted ALTERNATIVE queueing trigger — the normalizer carries that
explicitly on the request rather than synthesizing the label, and the handler gate becomes
"label OR explicit mention" when that path lands.

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
the deploy roster already knows about ship-it. *(Owner-confirmed: there is ZERO deploy so far.
Adding one will require substantial speccing, under the standing invariant that no application's
behavior changes without a human approving the change and applying it manually.)*

## 7. The dark steps are every step except groom-it

*(Owner-confirmed.)* Dark = all implemented steps other than the released `groom-it`: `code-it`
(+ its revisit), `spec-it`, `review-it`, and `validate-it` all ship `released: false`; flipping the
registry boolean is the launch act. No prior spec pinned the newer steps' I/O; this package defines
them: groom-it (ticket-quality assessment + proposed rewrite, comment-only), spec-it (code-grounded
spec draft + open questions + `suggestReady` hint, comment-only), review-it (severity-ranked
findings posted as ONE idempotent PR comment — never approve/request-changes/merge), validate-it
(read-only post-deploy verification — see §11). `mock-it-up` remains registry-only (design pending).

## 8. review-it's double verification is environment-dependent

When a consensus skill and the second model's CLI are present and authenticated, review-it runs the
review cross-model (independent reviews argued to agreement) and reports
`verificationMode: "cross-model-consensus"`; otherwise it degrades to `"single-model"` and says so
in the summary. The deploy follow-up should provision the second CLI + consensus skill in the
ship-it image for the cross-model path to be the norm.

## 9. PR-shaped events ride the same request shape

`prNumber` is an optional request field (review-it requires it; PR-less review events are advisory
skips). The global `ship-it` label gate currently applies to ALL init events — the label-less
GitHub-webhook path (gating on repo opt-in only) is part of the future normalizer work and will be
revisited when review-it is released.

## 10. Rollout starts from groom-it; code-it goes dark until then

The live release order starts from the least brittle step: `groom-it` (no working copy, no GitHub
access, no loops — worst case is an ignorable suggestion). `code-it`, `spec-it`, and `review-it`
are implemented but work-in-progress dark. The default status map gained a placeholder
`"To Groom" → groom-it` entry — like all default statuses it's tenant-specific and meant to be
overridden per project via `statusSkillMap`.

## 11. validate-it's contract is defined here (and release-blocked on a real deploy)

Read-only post-deploy verification: the skill derives checks from the acceptance criteria, runs
them ONLY through the project-provided `extensions.ship-it.validation` contract (provisional shape
`{environment?, baseUrl?, probes?: string[]}` — malformed config degrades to `{}` and the skill
reports `cannot-validate`), and reports pass/fail/skipped per check. It never mutates the deployed
system — no writes, replays, restarts, or rollbacks; humans act on failures. Its real trigger (a
deploy-completion event, or a scheduled delay after merge) is a seam that cannot exist before a
real deploy does, so the step stays dark until then — and per the one-pager it may graduate into
its own agent when released. Mention of revisit: validate-it is the one OTHER step that will likely
need `publishDelayed` (waiting for a deploy to land), the same machine-async pattern as code-it's
CI wait.

## 12. README/status updates ride with each release flip

Flipping a step's `released` boolean must come with the matching README status line and, when
relevant, a statusSkillMap default — the registry test pins entrypoint declarations but prose is
on the author.
