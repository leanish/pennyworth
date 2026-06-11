# triage-it — assumptions

Decisions made while building v1 that are contracts with components that don't exist yet
(or seams deliberately deferred). Revisit these when the surrounding pieces land.

1. **Evidence contract.** The request's `evidenceBlobUri` points at a **single `s3://bucket/key`
   tar.gz archive** produced by a separate evidence-collector component. That collector is the
   sole holder of data credentials and the sole PII/redaction boundary: the archive arrives
   **already customer-scoped and PII-filtered**, with a **`manifest.md` at the archive root**
   describing its contents. The collector itself is **out of scope** for this package — triage-it
   only ever reads the files it shipped and never connects to a datastore.

2. **Extraction safety caps.** The archive crosses a trust boundary, so extraction enforces:
   max **64 MiB** compressed archive, max **2000** entries, max **8 MiB** per file; absolute
   paths, `..` traversal, backslash separators, symlinks, hardlinks and every non-file/directory
   entry type are rejected; a missing root `manifest.md` rejects the archive. Rejections produce
   a terminal `validation-error` reply ("invalid evidence archive: …"). The caps are sized for
   "curated evidence bundle", not "data dump" — raise them deliberately if the collector's
   curation grows.

3. **`projectIds` is optional with a defined fallback.** When present, each id must resolve in
   the catalog's `triage-it` consumer view (an unknown id is a terminal `validation-error`, not a
   silent skip) and the synced working copies are mounted next to the evidence
   (`codeScope: "code+evidence"`). When absent, triage proceeds **evidence-only**
   (`codeScope: "evidence-only"`, logged) — there is no router-based project auto-selection
   in v1.

4. **Prior-ticket correlation is best-effort from evidence contents.** The skill surfaces
   `relevantPriorTickets` only from what the evidence bundle itself mentions. A richer
   ticket-search integration (querying the ticket system for similar resolved tickets) is a
   **deferred seam** — the output shape already carries it so consumers don't break when it
   lands.

5. **Replies and lifecycle reuse the consumer-envelope channel** exactly like ask-the-code:
   terminal reply to `envelope.replyTo` via SQS (at-least-once; consumers dedupe on
   `requestId`), lifecycle events (`triage-it.triage.received` / `.completed` / `.failed`) on
   EventBridge, signed envelopes verified via the shared consumer-registry + signing-key
   resolver pattern. No new transport was introduced.

6. **Single stage, no fan-out.** The descriptor declares `stages: [init]` only; no
   self-publisher is wired. If triage ever needs per-project fan-out, that's a phase-2-style
   change (descriptor stages + `runtime.publish`).

7. **Advisory only.** The agent and its `triage` skill never mutate anything — no write APIs,
   no downstream triggers. The terminal reply is the entire output.

8. **Execution overrides are not part of the request.** Unlike ask-the-code, the triage request
   carries no `execution` field; the descriptor's `codingAgent`/`model` always apply. Add the
   field to `request-schema.ts` if internal consumers ever need per-request overrides.
