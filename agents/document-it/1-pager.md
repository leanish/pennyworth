# Document-it — One-Pager

> **Keeps the docs honest — so they describe what the software actually does.**

*For approval. A plain-language summary of the Document-it assistant.*

## What it is

An assistant that regularly checks each opted-in project's **documentation against the actual code**
and **proposes** fixes wherever the two have drifted apart. It is the natural partner to Ask-the-code:
where Ask-the-code *tells* you what the code really does, Document-it *keeps the written docs matching
it*.

## What it does

- On a regular schedule, it reviews a project's documentation — both the docs that live with the code
  (README and guides) and published pages (e.g. a wiki / Confluence space).
- For each statement, it checks whether the code still works that way, and flags what is **out of
  date**, **incorrect**, or **missing**.
- It drafts the correction or the missing explanation and **proposes** it for a person to approve.

## Why it matters

- **Trustworthy documentation** — readers can rely on the docs because they're checked against
  reality, not left to rot.
- **Less drift** — docs are kept current continuously, instead of going stale until someone notices.
- **Saves expert time** — engineers approve a prepared, accurate update rather than rewriting docs
  from scratch.
- **Better onboarding & support** — accurate docs mean fewer wrong turns for new joiners, support,
  and partners.

## What it can and can't do

- ✅ Reviews docs against the code and proposes corrections and additions.
- ✅ Works on documentation in the code repositories and on published pages.
- ❌ **Never publishes a change on its own** — in the code repositories it opens a change for review;
  on published pages it leaves a suggestion. A person always approves and applies it.
- ❌ **Only acts on projects explicitly opted in.**
- ❌ **Not a style or formatting tool** — it targets accuracy (out-of-date, incorrect, missing), not
  rewrites or reformatting of text that is already correct.
- ❌ Reads code only to check the docs — it changes no software and touches no customer data.

## Data & safety

- **Proposes, never publishes** — every change waits for a person, both in the code repositories and
  on published pages.
- **Explicit opt-in** — it touches a project's docs only when deliberately enabled for it.
- **Reads code, changes nothing in the software** — it inspects source only to verify the docs.
- **No customer data** — it deals with code and documentation, not live customer information.
- **Auditable** — its proposed changes and its access to published-doc pages go through controlled,
  permission-scoped channels and are logged.

## Status

Planned for a later phase, building on the foundation and the safety model proven by the earlier
assistants — notably Secure-it's propose-and-approve flow.
