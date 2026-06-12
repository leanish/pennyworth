# `@leanish/triage-it`

Advisory triage agent — Layer-3 agent on `@leanish/runtime`. Given a problem (a ticket, a
customer complaint, an alert) plus a curated evidence bundle, it correlates configuration,
stats, and code (when in scope) and returns a **diagnosis + suggested next steps** for a person
to act on. It mutates nothing and triggers nothing downstream.

See the [1-pager](./1-pager.md) for the plain-language summary and
[ASSUMPTIONS.md](./ASSUMPTIONS.md) for the v1 contracts with not-yet-built components.

## Status

**v1 implemented** (agent side only — the evidence collector is a separate, future component).
The handler in `src/handler.ts`:

1. Validates the consumer request (`ticketKey`, `customer`, `evidenceBlobUri`, optional
   `problem` + `projectIds`) at the boundary.
2. Fetches the evidence archive (tar.gz) from S3 via `runtime.clients.s3`.
3. **Extracts it safely** to a fresh temp dir (`src/evidence.ts`): 64 MiB archive cap, 2000-entry
   cap, 8 MiB per-file cap, 256 MiB total-extracted cap; rejects absolute paths, `..` traversal,
   symlinks, hardlinks; requires `manifest.md` at the archive root. The temp dir is always
   removed in `finally`.
4. Resolves optional `projectIds` against the catalog (`triage-it` consumer view) and syncs
   working copies — or proceeds **evidence-only** when absent.
5. Runs the `triage` skill (`skills/triage/SKILL.md`) over the evidence (+ code, when mounted).
   The evidence dir rides along as the **last** working-copy mount — the coding-agent
   subprocess only gets file access to mounted directories, so in `code+evidence` runs the
   project working copy is the spawn cwd and the evidence is an `--add-dir`; evidence-only
   runs spawn directly inside the evidence dir.
6. Delivers the terminal reply to `envelope.replyTo` via SQS and emits lifecycle events
   (`triage-it.triage.received` / `.completed` / `.failed`) on EventBridge.

The AWS Lambda entry module is `src/lambda.ts` (`@leanish/triage-it/lambda`), wired the same
way as ask-the-code's: Dynamo idempotency + consumer registry, S3 catalog, `LocalGitWorkspace`,
SSM-backed signing-key resolver. Required env vars are documented in that module's header.

## Safety posture

- The agent holds **no database credentials** — it only ever reads files from the evidence
  bundle a separate collector produced (customer-scoped, PII-filtered upstream).
- **Advisory only**: the skill never mutates anything; the diagnosis is the entire output.
- Evidence is short-lived on disk: extract → diagnose → delete.

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test
npm run check             # typecheck + build + test
npm run test:integration  # LocalStack-backed end-to-end suite (needs LocalStack on :4566)
npm run check:full        # check + test:integration
```

## Layout

```
agent.yaml          # the descriptor (consumer trigger, signed envelopes, needs: s3/sqs/eventbridge)
skills/triage/      # the entry-point skill (schemas + prompt body)
src/
  agent.ts          # defineAgent({...}) — the runtime entry point
  handler.ts        # request → evidence → scope → skill → reply pipeline
  evidence.ts       # safe tar.gz extraction (caps + path/type rejection)
  request-schema.ts # TriageRequest + boundary validation
  lambda.ts         # AWS Lambda entry module
test/               # vitest specs (incl. crafted hostile-archive fixtures)
test-integration/   # LocalStack end-to-end suite (real S3/SQS/DDB/SSM/EventBridge)
```
