# Ship-it — One-Pager

> **Shepherds a ticket from idea to done — with a person at every gate.**

*For approval. A plain-language summary of the Ship-it assistant.*

## What it is

A single assistant that helps move a ticket through its whole lifecycle — grooming, specification,
implementation, review, and post-deploy validation — by doing the right step at each stage. The
**ticket's own workflow drives it**: when a ticket moves to a new state, Ship-it does that state's job.
It **never merges or deploys on its own** — a person approves every consequential step.

## The steps (added over time, not all at once)

- **groom-it** — turn a raw ticket into a clear, product-ready one *(later)*
- **mock-it-up** — optional design mockups during grooming *(later)*
- **spec-it** — refine the ticket's specification, with people iterating on it *(phase 3)*
- **code-it** — implement the ready ticket, get the tests passing, open it for review *(phase 1)*
- **review-it** — review the change with a *second, independent AI* (a different model than wrote it)
  *(phase 2)*
- **validate-it** — check the change, once deployed to staging/production, actually works as expected
  *(later)*

## Why one assistant (not six)

Bundling the lifecycle into one assistant keeps it **simple to run and improve** — and we don't need
every stage from day one. If any single step ever needs stronger isolation (for example,
**validate-it**, which touches the running staging/production system), it can be **split into its own
assistant later** without disrupting the rest.

## Why it matters

- **Flow, not hand-offs** — each stage's busywork is handled, so people spend their time on judgment.
- **Faster, more consistent delivery** — specs get sharpened, implementations are tested, changes are
  independently reviewed.
- **A person stays in control** — nothing merges or ships without explicit human approval.

## What it can and can't do

- ✅ Does the right step for each ticket state and proposes the result for review.
- ❌ **Never merges or deploys on its own.**
- ❌ **Only acts on opted-in projects, and only when a person advances the ticket.**
- ❌ Doesn't guess — when a ticket is unclear, it asks.

## Data & safety

- **Proposes, never ships** — humans perform every merge and deploy.
- **Two deliberate gates** on implementation — the project must be enabled, and a person must mark the
  ticket ready.
- **Independent review** — changes are reviewed by a different AI model before a person approves.
- **Minimal data exposure** — it works with code and tickets; the later validate-it step checks that a
  deployment behaves correctly, under the suite's standard data-safety controls.
- **Auditable** — its changes, reviews, and ticket comments go through controlled, logged channels.

## Honest note

The implementation step writes open-ended code, so quality varies and it works best on well-scoped,
clearly specified tickets. Human review is the real safeguard — by design, nothing merges or ships
without a person.

## Status

The most ambitious assistant; rolled out step-by-step over later phases — implementation first, then
review, then specification, with grooming / mockups / validation following.
