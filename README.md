# pennyworth

**leanish** — *a butler for your codebase.* A suite of focused, human-gated AI agents on a shared
runtime: they handle the toil (questions, dependencies, docs, triage, drafts) and hand everything
back **for your review**. Focus on the product, not the plumbing.

🌐 **[The docs site](https://leanish.github.io/pennyworth/)** ·
🎞️ **[The presentation](https://leanish.github.io/pennyworth/presentation/)**

## Why

Engineering runs on toil: answering the same code questions, chasing dependency updates, watching
docs drift, re-triaging familiar problems. Each is small; together they crowd out product work —
and each is exactly what a coding agent does well *if* it's pointed at one narrow job and never
allowed to act on its own conclusions. That's the whole idea here: **AI does the legwork, a person
makes every call** ([overview](https://leanish.github.io/pennyworth/overview.html)).

## The fleet

| Agent | Posture | In one line |
|---|---|---|
| [ask-the-code](agents/ask-the-code/README.md) | reads | Plain-language answers grounded in the actual source. |
| [triage-it](agents/triage-it/README.md) | advises | Evidence in, diagnosis + next steps out; mutates nothing. |
| [bump-it](agents/bump-it/README.md) | proposes | Dependency/security upkeep: one batched draft PR per project, revisited until CI is green. |
| [document-it](agents/document-it/README.md) | proposes | Audits docs against code; batches fixes into one draft PR. |
| [ship-it](agents/ship-it/README.md) | proposes | Runs the right `-it` skill for a ticket's state — a person at every gate. |
| [ship-it-normalizer](agents/ship-it-normalizer/README.md) | *gate* | Verifies, filters, and signs inbound webhooks so only relevant events start an agent. |

*(monitor-it — alerts → triaged recommendation — is designed, not yet built.)*

**Proposes** means draft PRs and comments only: no agent merges, approves, deploys, or transitions
final state. Write-capable agents also require a per-project **opt-in** in the catalog. The full
tour is on [the fleet page](https://leanish.github.io/pennyworth/fleet.html).

## How it's built

Four layers ([architecture](https://leanish.github.io/pennyworth/architecture.html)): a **catalog** of projects + per-agent opt-ins,
one shared **runtime** that does all the mechanical plumbing in deterministic code and starts a
coding agent (Claude/Codex) only where judgment is needed, the **fleet** of thin independently
deployable agents, and **CDK infra** that provisions each agent from its own descriptor. Signed
envelopes, DynamoDB idempotency, and scoped IAM make it safe to say yes to; the webhook gate plus
deterministic plumbing keep the cost proportional.

## Quick start (local)

```bash
npm install
docker compose up -d localstack        # LocalStack backs the integration suites
npm run check --workspaces             # typecheck + build + unit tests, every package
npm --workspace @leanish/ask-the-code run smoke:local   # one Q&A through the real pipeline (fake-runner wiring; no live model needed)
```

Packages with a LocalStack integration suite also expose `npm run check:full` (the fast `check`
stays Docker-free). The integration gate fails loudly if LocalStack isn't running — it never
silently skips.

## Layout

- **`core/`** — the framework: [`runtime`](core/runtime/README.md) (shared runtime + bundled
  skills) and [`catalog-it`](core/catalog-it/README.md) (project catalog: read-only library +
  curation CLI)
- **`agents/`** — the fleet (each independently deployable)
- **`infra/`** — AWS CDK; provisions every agent from its descriptor (app repos carry zero IaC)
- **`docs/`** — the source of [the docs site](https://leanish.github.io/pennyworth/) and the
  [presentation](https://leanish.github.io/pennyworth/presentation/) (GitHub Pages serves this
  directory), plus the engineering record ([assumptions](docs/assumptions.md))

## About this repo

A monorepo consolidation of what were previously separate component repos — **full git history
preserved** for each. Packages still publish and deploy independently; the monorepo just makes the
suite easy to find and work in.

> The engineering **design docs** (CONTEXT / overview / ADRs) are maintained separately. This repo
> carries the code, the docs above, and the public front door.
