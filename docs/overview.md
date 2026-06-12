# Overview — what pennyworth is and why

**pennyworth** is the home of **leanish** — *a butler for your codebase*: a suite of focused,
human-gated AI agents on one shared runtime. The agents handle the recurring toil around a codebase
— questions, dependency upkeep, docs drift, triage, ticket drafting — and hand everything
consequential back to a person for review.

For the narrated version of this page, see the [presentation](presentation/index.html). For the
moving parts, see [architecture.md](architecture.md). For who does what, see [fleet.md](fleet.md).

## The problem it solves

Engineering teams lose a steady tax to work that is necessary but mechanical:

- Answering *"how does this part work?"* for the hundredth time.
- Chasing dependency updates until something falls behind — and becomes a security problem.
- Docs that quietly drift away from what the code actually does.
- Re-triaging the same kinds of problems from scratch, every time.
- Shepherding well-understood tickets through the same lifecycle steps.

Each item is small; together they crowd out product work. They are also exactly the kind of work a
coding agent does well — *if* it is pointed at one narrow job, given the right context, and never
allowed to act on its own conclusions.

## How it works (the one-paragraph version)

A **catalog** records which projects exist and which agents each project has opted into. A shared
**runtime** does all the mechanical plumbing in plain, deterministic code — queues, signatures,
idempotency, working copies, skill staging — and starts a **coding agent** (Claude or Codex)
only for the step that needs judgment. Each **agent** in the fleet is a thin, independently
deployable specialist over that runtime. **Infrastructure-as-code** reads each agent's descriptor
and provisions exactly what it declares. Nothing consequential leaves the system without a human
decision.

Every agent fits one of three safety postures:

| Posture | Meaning | Agents |
|---|---|---|
| **reads** | answers questions; touches nothing | ask-the-code |
| **advises** | produces a diagnosis or recommendation; mutates nothing | triage-it, *(future)* monitor-it |
| **proposes** | opens **draft** PRs or comments; never merges, approves, deploys, or transitions final state | secure-it, document-it, ship-it |

## What it optimizes for

1. **Human judgment stays human.** Proposing agents stop at draft PRs and comments. The system has
   no path that merges, deploys, or closes a ticket on its own — a person sits at every gate.

2. **Cost discipline.** Two mechanisms keep the bill proportional to value: the **gate** (webhook
   filtering means irrelevant events never start an agent) and **deterministic plumbing** (the
   coding agent — the expensive part — runs only where judgment is needed, never for the
   mechanical work around it).

3. **Trust by construction, not policy.** Write-capable agents require a per-project, per-agent
   **opt-in** in the catalog (strictly `enabled: true`). Consumer messages are HMAC-signed and
   verified against a consumer registry. Each agent's IAM is scoped to exactly what its descriptor
   declares. Secrets are redacted from logs; correlation ids make every run auditable.

4. **Operability through boring technology.** SQS, Lambda, DynamoDB, S3, EventBridge — managed
   pieces an ops team already knows, provisioned by CDK from each agent's own descriptor.
   Everything can also run locally: `run-local` + LocalStack reproduce the production seams on a
   laptop.

5. **Extensibility without bloat.** Agents are thin; shared behavior lives in the runtime; new
   behavior is usually just a new **skill** — a small, focused instruction set the runtime stages
   into the coding agent. Agents never call each other; they meet at the ticket and the PR, so the
   suite grows without growing a central brain.

## What it deliberately is not

- **Not autonomous.** No agent acts on its own conclusions; "propose, never act" is the contract.
- **Not a platform to orchestrate agents.** Your existing workflow (tickets, PRs, reviews) is the
  orchestrator; the fleet plugs into it.
- **Not a monolith.** Each agent deploys independently and can be adopted (or dropped) one at a
  time, per project.

## Where things stand

All five agents (plus ship-it's webhook gate) are implemented on the shared runtime with unit and
LocalStack-backed integration suites; CDK stacks synthesize and are assertion-tested. The remaining
distance to a first cloud deployment is wiring, not design — see [future.md](future.md) for the
honest list. Status is tracked in plain language on the presentation's
["where it stands" slide](presentation/index.html#10).
