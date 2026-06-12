# @leanish/ship-it-normalizer

The **webhook normalizer** for [ship-it](../ship-it): a single AWS Lambda (HTTP via a Lambda
Function URL) that **gates, filters, and normalizes** inbound Jira and GitHub webhook events into
signed `ship-it-event` envelopes and sends them to ship-it's input SQS queue.

To the rest of the suite it is *just another registered consumer*: it registers in ship-it's
ConsumerRegistry as `webhook-normalizer` with `allowedKinds: ["ship-it-event"]` and signs every
envelope with its registered key. Nothing in ship-it special-cases it.

```
Jira / GitHub webhook → Function URL → verify → dedupe → normalize+gate → sign → SQS → ship-it
```

## Routes

| Path      | Provider | Inbound auth                                                  |
| --------- | -------- | ------------------------------------------------------------- |
| `/github` | GitHub   | `X-Hub-Signature-256` HMAC-SHA256 over the raw request bytes |
| `/jira`   | Jira     | `x-leanish-webhook-secret` static shared secret (v1 seam)    |

Signature verification always runs on the **exact raw request bytes**, before any JSON parsing.

## The gate table

| # | Gate | Route | Outcome on miss |
| - | ---- | ----- | --------------- |
| 1 | Signature / shared-secret verification | both | `401` |
| 2 | Delivery dedupe (`<route>:<deliveryId>:<action>`) | both | `200 {"deduped": true}` |
| 3 | Supported event (`issue_updated` / `issue_labeled` / `comment_created`) | jira | `204` (filtered) |
| 4 | Jira project key mapped via `JIRA_PROJECT_MAP` | jira | `204` (filtered) |
| 5 | **Strict** catalog opt-in: `extensions["ship-it"].enabled === true` | both | `204` (filtered) |
| 6 | Admission: `ship-it` label (mode `label`) OR `@ship-it` comment mention (mode `mention`, comment-created only) | jira | `204` (filtered) |
| 7 | Action is `ready_for_review` or `synchronize` | github | `204` (filtered) |
| 8 | `pull_request.draft === false` (a draft `synchronize` never fires review-it early) | github | `204` (filtered) |
| 9 | Head branch parses as `ship-it/<ticketKey>` | github | `204` (filtered, logged) |

Filtered events are answered `204` with a structured log of WHY (`reason` + detail fields), so the
provider stops retrying and operators can still audit every decision. Admitted events are signed
and sent, answered `202`. Unexpected failures are `500` with a logged error; log lines never
contain secrets.

GitHub-admitted events carry the **synthetic** ticket status `"PR Ready for Review"`
(`PR_READY_FOR_REVIEW_STATUS`): PRs have no ticket workflow status, so projects map this constant
to the `review-it` step via `extensions.ship-it.statusSkillMap` when review-it releases.

## Environment variables

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC secret shared with the GitHub webhook. |
| `JIRA_WEBHOOK_SECRET` | yes | Static shared secret the Jira webhook sends in `x-leanish-webhook-secret`. |
| `ENVELOPE_SIGNING_KEY` | yes | Base64 signing-key bytes for outbound envelopes (SSM-SecureString-backed at deploy). |
| `SHIP_IT_QUEUE_URL` | yes | ship-it's input SQS queue. |
| `CATALOG_BUCKET` | yes | S3 bucket holding the catalog bundle. |
| `JIRA_PROJECT_MAP` | yes | JSON: Jira project key → catalog projectId, e.g. `{"ABC": "acme/widgets"}`. |
| `CATALOG_KEY` | no | Catalog object key; defaults to `catalog.json`. |
| `JIRA_ACCEPTANCE_FIELD` | no | Jira custom field id carrying acceptance criteria. |
| `AWS_REGION` | no | Defaults to `us-east-1`. |

Inbound webhook secrets and the outbound envelope signing key are deliberately **separate**
credentials: one authenticates providers to this Lambda, the other authenticates this Lambda to
ship-it. Rotating one never touches the other.

## ConsumerRegistry bootstrap (deploy-time step)

ship-it verifies every inbound envelope against its ConsumerRegistry. Before the normalizer's
first delivery, the registry **must** contain:

```json
{
  "consumerId": "webhook-normalizer",
  "signingKey": { "kind": "ssm-parameter", "name": "<the parameter backing ENVELOPE_SIGNING_KEY>" },
  "allowedKinds": ["ship-it-event"]
}
```

with key material matching this Lambda's `ENVELOPE_SIGNING_KEY`. Without that record every
envelope is rejected as `unknown-consumer`; with a mismatched key, as `bad-signature`.

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test
npm run check             # typecheck + build + test
npm run test:integration  # LocalStack-backed end-to-end suite (docker compose up -d localstack)
npm run check:full        # check + test:integration
```

## Known first-draft limits

See [ASSUMPTIONS.md](./ASSUMPTIONS.md) — most importantly: the in-memory dedupe store only covers
a warm Lambda container and is a **production blocker** until the DynamoDB-backed store replaces
it.
