# `@leanish/catalogit`

Catalog read-side library for the leanish agent suite. Defines the canonical `Project` shape and ships three `CatalogReadOnly` implementations — `FilesystemCatalog` (reads catalogit's per-project YAML layout), `S3Catalog` (reads the deployed `catalog.json` bundle from S3), and `InMemoryCatalog` (for tests and fixtures).

**Specs**: `../../specs/agentic-development/catalogit/` — `data-format.md`, `library-api.md`. Suite-level: suite-0001 (four layers), suite-0007 (catalogit naming), suite-0008 (spine + free-form description).

**Sibling projects under `agentic-development/`** (per suite-0004):

- `../agent-runtime/` — consumes catalogit; re-exports the canonical types for downstream agents.
- `../agent-atc/` — uses catalog access via `runtime.catalog` (ATC Q&A backend).
- `../agent-secureit/` — same.

## Public API

```ts
import {
  // Types
  type Project,
  type ProjectSource,
  type CatalogReadOnly,
  type ConsumerCatalogView,
  type CatalogBundle,

  // Implementations
  FilesystemCatalog,
  InMemoryCatalog,
  S3Catalog,

  // Helpers
  isEnabledForConsumer,
  parseProjectYaml,
  parseBundle,
} from "@leanish/catalogit";
```

## Layout

```
src/
  project.ts            # Project, ProjectSource — the canonical shape
  catalog.ts            # CatalogReadOnly, ConsumerCatalogView — the read surface
  consumer-filter.ts    # isEnabledForConsumer — default-on opt-in convention
  filesystem-catalog.ts # reads <root>/projects/<owner>_<slug>.yaml
  s3-catalog.ts         # reads s3://<bucket>/catalog.json
  in-memory-catalog.ts  # for tests + synthetic fixtures
  index.ts              # public exports
```

## Scripts

```bash
npm install
npm run typecheck       # tsc -b --noEmit + tsc -p tsconfig.test.json --noEmit
npm run build           # tsc -b + chmod +x dist/bin/catalogit.js
npm test                # vitest run
npm run check           # typecheck + build + test — the phase-1 acceptance gate
```

## Test scaffolding

catalogit is the lowest layer in the suite (no agent-runtime dependency).
The single public surface (`@leanish/catalogit`) exports everything tests
need — including `InMemoryCatalog` and `isEnabledForConsumer` — so there
are no sub-entrypoints here.
