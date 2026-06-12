# Documentation

The map of everything written about the suite. Start with the row that matches what you came for.

| You want to… | Read | Status |
|---|---|---|
| Get the idea in a 12-slide deck | [presentation](presentation/index.html) ([view online](https://htmlpreview.github.io/?https://github.com/leanish/pennyworth/blob/main/docs/presentation/index.html), interim link until GitHub Pages is enabled) | current |
| Understand what it solves and what it optimizes for | [overview.md](overview.md) | current |
| See how it's put together | [architecture.md](architecture.md) | current |
| Know who does what in the fleet | [fleet.md](fleet.md) | current |
| See what's next / open / possible | [future.md](future.md) | current |
| Review cross-cutting implementation decisions | [assumptions.md](assumptions.md) | current |
| Audit the monorepo consolidation (history preservation) | [consolidation-history.md](consolidation-history.md) | historical record |
| Check the phase-1 acceptance gates | [PHASE-1-ACCEPTANCE.md](PHASE-1-ACCEPTANCE.md) | historical record — predates the monorepo naming and references the private design repo |

Package-level depth lives next to the code — each package README is the source of truth for its
internals:
[core/runtime](../core/runtime/README.md) ·
[core/catalog-it](../core/catalog-it/README.md) ·
[agents/ask-the-code](../agents/ask-the-code/README.md) ·
[agents/secure-it](../agents/secure-it/README.md) ·
[agents/document-it](../agents/document-it/README.md) ·
[agents/triage-it](../agents/triage-it/README.md) ·
[agents/ship-it](../agents/ship-it/README.md) ·
[agents/ship-it-normalizer](../agents/ship-it-normalizer/README.md) ·
[infra](../infra/README.md)

> The suite's **design contract** (suite-wide invariants, ADRs) is maintained separately from this
> repo; these docs describe the implementation as it exists here.
