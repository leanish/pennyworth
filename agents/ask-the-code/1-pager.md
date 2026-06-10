# Ask-the-code — One-Pager

> **What the code does — not what the docs claim.**

*For approval. A plain-language summary of the Ask-the-code assistant.*

## What it is

An assistant that answers questions about **how our software works**, in plain language, by reading
the actual source code. Anyone — engineering, product, support, leadership — can ask and get a
grounded answer.

## What it does

- You ask a question: *"How does the checkout flow work?"*, *"Why does the system send two emails
  here?"*, *"Where is X configured?"*
- It reads the relevant code across the organization's projects and replies with a clear,
  synthesized answer.
- It tailors the answer to the reader: a plain-language explanation for a non-engineer, or
  file-and-detail level for an engineer.
- Available where people already work: a web page and chat.

## Why it matters

- **Ground truth** — because it reads the source code itself, answers reflect what the system
  *actually does today*, not what an out-of-date document or comment claims.
- **Faster answers** — minutes, instead of waiting for an engineer to be free.
- **Fewer interruptions** — routine "how does this work?" questions don't pull an engineer off their work.
- **Easier onboarding** — new joiners can explore how systems work on their own.
- **Shared understanding** — product, support, and engineering ask the same source of truth.

## What it can and can't do

- ✅ Reads source code and explains it.
- ✅ Answers about a curated set of the organization's projects.
- ❌ **Never changes code or any system** — it is strictly read-only.
- ❌ No access to customer data or production systems — it reasons about code, not live data.

## Data & safety

- **Read-only by design** — the worst case is an unhelpful answer, never an unintended change.
- **Curated scope** — it only sees the projects we have deliberately added.
- **Access-controlled** — only registered, authenticated channels (the web app, the chat bot) can
  ask, and every request is attributed to a user.
- **Auditable** — questions and activity are logged.

## Status

First of the assistants to roll out. It is the foundation the others build on.
