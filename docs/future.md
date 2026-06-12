# Future — what's next, what's open, what's possible

Three honest buckets: **validating** (implemented, being hardened), **blockers** (known distance to
a first production deployment), and **possibilities** (ideas we like but have not committed to).
No dates — see the [presentation roadmap slide](presentation/index.html#11) for the sequencing
story.

## Validating now

- **Integration coverage across the fleet** — LocalStack-backed suites for the core packages and
  every agent, plus registry⇄descriptor consistency tests and CDK template assertions in infra.
- **Deploy wiring** — per-agent queue/DLQ pairs, recurring scheduler ticks for the scheduled
  agents, self-publish env + grants for multi-stage agents, and the webhook gate's stack all
  synthesize and are assertion-tested; not yet exercised against a real AWS account.

## Known blockers to a first cloud deployment

- **Per-agent container images** — the base image + ask-the-code's Dockerfile exist (and rehearse
  through the AWS Runtime Interface Emulator); the other agents and the normalizer still need
  their image pipelines.
- **Secret-backed env resolution** — `github`/`jira` credentials and the normalizer's webhook
  secrets should resolve from SSM SecureStrings at cold start; today they ride plain env vars.
- **Durable webhook dedupe** — the normalizer's dedupe store is in-memory (documented production
  blocker); it needs the DynamoDB-backed store before real webhook traffic.
- **Operator bootstrap** — consumer-registry rows (e.g. the normalizer's) are a documented
  deploy-time operator step; no tooling for it yet.

## Committed direction (no dates)

- **ship-it step rollout** — the steps are implemented and **dark**; each flips live one boolean at
  a time once the previous one earns trust: groom-it (live) → code-it → review-it → spec-it →
  validate-it.
- **monitor-it** — the sixth specialist (alerts → triaged recommendation): designed, not built.
- **A chat front-end for ask-the-code** — answers currently land on a reply queue; a Slack-style
  surface is the natural consumer. Not specced yet.

## Possibilities (explicitly speculative)

- **More entry points** — additional trackers and chat surfaces normalize into the same envelope
  shape the gate already produces; each new consumer is a registry row, not a new architecture.
- **`run-local` fan-out drain** — local mode currently processes one message; draining
  self-published follow-ups (with a depth cap) would make whole multi-stage flows replayable on a
  laptop.
- **Cost/execution observability** — per-run token + time accounting rolled up per ticket/project,
  making "what did this cost?" a queryable fact. The presentation's *cost-tracked* card is this,
  stated as intent.
- **More coding agents** — the runner seam is already plural (Claude + Codex); anything with a CLI
  and structured output could slot in.
- **validate-it as its own agent** — post-deploy validation needs a real deploy signal and a
  per-project validation contract; if that grows, it may graduate from a ship-it step to a
  standalone specialist.

## How to read this page

Anything in *validating/blockers* is engineering follow-through on decisions already made (the
cross-cutting ones are in [assumptions.md](assumptions.md)). Anything under *possibilities* is
deliberately uncommitted — if you pick one up, write the one-pager first, the way every existing
agent started.
