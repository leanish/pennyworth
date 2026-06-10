# Triage-it — One-Pager

*For approval. A plain-language summary of the Triage-it assistant.*

## What it is

An internal **triage tool**. When a problem comes in, it gathers the relevant evidence and
produces a **diagnosis with suggested next steps** — for a person to act on. It is advisory: it
explains what is likely wrong and why; it does not fix anything itself.

## Who it's for

**Technical Success Managers and Support first.** They handle the incoming problems triage-it is
built for, and get the evidence gathered and correlated instead of digging by hand. Engineers are
the second audience — escalations arrive pre-investigated. Customer Success benefits indirectly:
faster, better-grounded answers to customers without doing the digging themselves.

## What it does

- Starts from an incoming problem — a support ticket, a customer complaint, or an alert.
- Pulls together the evidence that matters: the related code, the customer's relevant configuration,
  recent stats, and similar problems from the past and how they were resolved.
- Produces a **diagnosis plus suggested next steps**, which a person reviews and acts on.

## Why it matters

- **Faster triage** — the evidence is gathered and correlated in one place, instead of someone
  digging across code, configuration, dashboards, and old tickets by hand.
- **Better-grounded decisions** — diagnoses are based on the actual code and the specific customer's
  setup, plus how similar past cases were handled.
- **Leverage on hard-won knowledge** — past resolutions are surfaced automatically.

## What it can and can't do

- ✅ Diagnoses and suggests next steps.
- ✅ Reads the relevant code and a carefully limited slice of a customer's configuration and stats.
- ❌ **Makes no changes and triggers nothing** — strictly advisory.
- ❌ **Never has direct access to customer databases.**
- Internal use only.

## Data & safety (the important part)

Triage-it deals with customer data, so its safeguards are the strictest:

- **The assistant never holds database credentials.** A separate, tightly controlled component is the
  *only* thing that touches the data.
- **Only the data needed, with personal data filtered out.** That component fetches just the
  relevant, customer-scoped slice and removes personal information before the assistant ever sees it.
- **Ticket access is mediated** — it reads tickets through a permission-scoped, audited channel, not
  a back door.
- **Advisory only** — because it changes nothing, the worst case is a suggestion a person chooses not
  to follow.
- **Auditable** — every data fetch (which customer, what was read, for which case) is logged.

## Status

Planned for a later phase, building on the foundation from the earlier assistants.
