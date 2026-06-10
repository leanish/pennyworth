# Secure-it — One-Pager

*For approval. A plain-language summary of the Secure-it assistant.*

## What it is

An assistant that keeps our software's third-party components **up to date** — automatically
preparing the updates and proposing them for a person to review and approve.

## Why this matters

Modern software is built on top of many third-party building blocks ("components"). They release new
versions constantly — for security fixes, bug fixes, and improvements. Keeping them current is
essential for security and stability, but doing it by hand is tedious, easy to deprioritize, and a
common source of risk when it falls behind.

## What it does

- On a regular schedule, it checks each opted-in project for out-of-date components.
- It prepares the updates, bundles them into a single proposed change, and runs the project's
  automated tests against them.
- If the tests pass, it marks the change **ready for a person to review and approve**.
- If something breaks, it tries to fix it; if a particular update can't be made to work, it sets that
  one aside and keeps the rest, leaving a note explaining what it skipped and why.

## Why it matters

- **Lower security risk** — components stay current, closing known weaknesses sooner.
- **Audit-ready** — annual security audits routinely ask whether there is a defined, repeatable
  process for keeping systems secure and patched. Secure-it is part of that process: automated, consistent,
  and documented, with **fast reaction times** when a new fix or version is released — far quicker
  than manual upkeep that competes with other priorities.
- **Less manual toil** — engineers review a prepared, tested change instead of doing the upkeep by hand.
- **Consistency** — every opted-in project gets the same regular care.

## What it can and can't do

- ✅ Proposes updates as ready-to-review changes.
- ✅ Runs the automated tests and attempts to fix breakages.
- ❌ **Never puts a change live on its own** — a person always reviews and approves before anything ships.
- ❌ **Only acts on projects explicitly opted in** — it does nothing to a project until a team turns it on.

## Data & safety

- **Proposes, never ships** — the human approval step is mandatory and built in.
- **Explicit opt-in** — a write-capable assistant, so it touches a project only when deliberately
  enabled; a newly added project is never auto-enrolled.
- **Least privilege** — its access is scoped to exactly the work it does.
- **No destructive actions** — it adds proposed changes; it never rewrites history or forces changes through.
- **Auditable** — its activity on each project is logged.

## Status

Planned as the second assistant to roll out, after Ask-the-code.
