# ship-it-normalizer — assumptions (first draft)

Decisions taken for the zero-deploy v1 that are not (yet) backed by their production-grade
counterparts, plus the trust acknowledgments an operator should know about.

## 1. In-memory dedupe is a PRODUCTION BLOCKER

`InMemoryTtlDedupeStore` (Map + TTL, default 15 minutes, lazy eviction) only covers a **warm
Lambda container**. A cold start, a concurrent container, or a redeploy starts with an empty map,
so provider redeliveries across containers are NOT suppressed. Deliberate for the zero-deploy v1
— the `DedupeStore` interface is the seam (claim/release: a failed send RELEASES the claim so the
provider's retry is admitted; a filtered decision keeps it). The production deploy MUST replace it
with a DynamoDB-backed store (conditional put on the dedupe key with a TTL attribute; delete on
release) before real webhook traffic flows. There is NO downstream redelivery guard: the runtime
shim's idempotency claim keys on the SQS MessageId, and a redelivered webhook becomes a new SQS
message — this store is the only line of defense.

## 2. `canonicalize` comes from the runtime's main entry

The envelope canonicaliser is imported from `@leanish/runtime` (the main entry already exports it —
the original design expected a `/testing`-only export and recorded a follow-up; the follow-up
turned out to be unnecessary). The round-trip test (normalizer envelope → runtime `verifyEnvelope`)
pins signature compatibility.

## 3. Jira inbound auth is a static shared secret (v1 seam)

`/jira` is authenticated by the `x-leanish-webhook-secret` header compared timing-safely (both
sides SHA-256-hashed first so lengths always match). This is the v1 trust seam; Jira
Connect-style JWT verification replaces it later. `verify-jira.ts` is the single place that
changes.

## 4. `JIRA_PROJECT_MAP` is provisional

Mapping Jira project keys to catalog projectIds via an env JSON map keeps v1 config in one place,
but couples a deploy to tenant ticket-space layout. The likely successor is a per-ticket custom
field (or a catalog-extension mapping) owned by the project itself. Unmapped projects are
filtered, never errored.

## 5. The synthetic `"PR Ready for Review"` status

GitHub PR events carry no ticket workflow status, so admitted PR events get the exported constant
`PR_READY_FOR_REVIEW_STATUS = "PR Ready for Review"`. Projects map it to the `review-it` step via
`extensions.ship-it.statusSkillMap` when review-it releases; until then ship-it's handler skips it
as an unmapped status (advisory, by design).

## 6. ship-it-scoped placement (may graduate suite-level)

The package lives beside `agents/ship-it` (not under `core/`) because in v1 it is ship-it-scoped:
it imports `@leanish/ship-it` for the request contract and produces only `ship-it-event`
envelopes. If a second agent grows a webhook front door, the route/verify/dedupe plumbing
graduates to a suite-level package and the ship-it-specific normalizers stay behind.

## 7. First-draft behavior decisions (smaller print)

- **Malformed provider payloads are filtered, not failed**: a structurally surprising body on an
  authenticated route (missing issue/fields, non-object pull_request, missing required strings)
  answers 204 with a logged reason. 500s are reserved for actual bugs/outages, and webhook
  providers retry 5xx — retrying cannot fix a shape.
- **Signed-but-non-JSON bodies answer 400** (the pipeline step between verify and dedupe).
- **GitHub deliveries missing `x-github-delivery`** (never expected) fall back to a SHA-256 of
  the raw body as the delivery id, mirroring the Jira fallback, so a missing header cannot
  collapse all deliveries onto one dedupe key.
- **Jira actor resolution**: comment events use `comment.author.accountId`, issue events the
  top-level `user.accountId`; if neither is present the endUser falls back to `jira:unknown`
  after a warn log (same pattern as `github:unknown`).
- **Structural additions** beyond the designed module list (no behavior change):
  `src/normalize-result.ts` (the shared normalize-outcome type + the strict opt-in gate both
  normalizers apply) and `src/index.ts` (the package barrel, mirroring the fleet's package
  shape).
