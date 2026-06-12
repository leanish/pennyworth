# Assumptions

Decisions made while building the first cut of `@leanish/document-it` that are **not** settled
contract yet. Revisit each before promoting the agent past its current phase.

1. **`docSet` shape is provisional (invented here).** The project → published-docs mapping is read
   from `extensions["document-it"].docSet` with the shape
   `{ space?: string, pageIds?: string[], labels?: string[] }`. The catalog does not define this
   descriptor; the handler narrows it defensively (well-typed fields pass through, anything else
   degrades to `{}` → repo-only audit). If the catalog later standardises a doc-set descriptor, the
   handler's `extractDocSet` and the skill's `inputSchema` must follow it.

2. **Published-page suggestion POSTING is a deferred seam.** v1 returns published-doc suggestions in
   the `verify-docs` skill output (`publishedDrift`) and logs a count — nothing is posted to any
   external system. The delivery channel (and its batching/dedup rules) is a later phase; the skill
   prompt explicitly forbids posting anywhere.

3. **One batched docs-drift PR per project on a stable branch.** All in-repo corrections for a
   project land on `document-it/docs-drift` as a single draft PR, updated idempotently across audit
   runs (no per-finding PRs, no second PR while one is open). Granularity may be revisited if
   batched PRs prove too large to review.

4. **Container image pipeline is deferred.** The infra package now provisions the deploy wiring
   from the `infra/src/registry.ts` registration (input queue + DLQ, the recurring `rate(1 day)`
   stage=init tick, the per-agent schedule group + Scheduler delivery role, and the `SELF_*` /
   `SCHEDULE_*` Lambda env contract `src/lambda.ts` reads). What is still missing is the package's
   Dockerfile and the image build/publish pipeline; `DOCUMENT_IT_IMAGE_TAG` selects the image when
   that lands.

5. **The strict opt-in filter is duplicated in the handler.** `forConsumer("document-it")` is
   default-on (only an explicit `enabled: false` excludes), which is too permissive for a
   write-capable agent; the handler re-checks `extensions["document-it"].enabled === true` in both
   stages (init fan-out AND breakdown). The breakdown re-check guards against catalog changes
   between fan-out and audit.

6. **AWS SDK clients are direct dependencies.** The contractually minimal dependency set was
   `@leanish/runtime` only, but `DynamoIdempotencyStore` and `S3Catalog.load` take injected clients,
   so `src/lambda.ts` needs `@aws-sdk/client-dynamodb` and `@aws-sdk/client-s3` (same pattern and
   versions as ask-the-code's Lambda entry).

7. **No execution-override plumbing in the handler.** Payloads inherit the optional `execution`
   field from `AgentPayloadBase`, but the handler does not resolve or forward it to `runSkill` —
   the descriptor's `codingAgent`/`model` defaults always apply. Wire `runtime.execution.resolve`
   through if per-message overrides become a real need.

8. **Breakdown never re-publishes and a malformed payload is dropped, not retried.** A breakdown
   message with a missing/empty `projectId` is logged at error level and acknowledged (returning
   normally) rather than thrown, because redelivery cannot fix a malformed self-published payload.
