# `@leanish/catalog-it`

Catalog read-side library for the leanish agent suite. Defines the canonical `Project` shape and ships three `CatalogReadOnly` implementations — `FilesystemCatalog` (reads catalogit's per-project YAML layout), `S3Catalog` (reads the deployed `catalog.json` bundle from S3), and `InMemoryCatalog` (for tests and fixtures).

**Specs**: design contract — `data-format.md`, `library-api.md` — maintained separately. Suite-level: suite-0001 (four layers), suite-0007 (catalog-it naming), suite-0008 (spine + free-form description).

**Sibling projects under `agentic-development/`** (per suite-0004):

- `../runtime/` — consumes catalogit; re-exports the canonical types for downstream agents.
- `../../agents/ask-the-code/` — uses catalog access via `runtime.catalog` (ATC Q&A backend).
- `../../agents/secure-it/` — same.

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
} from "@leanish/catalog-it";
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

## CLI

`catalogit` also ships a curation CLI (compiled to `dist/bin/catalogit.js`; run `catalogit --help` for the full reference). Subcommands:

- `validate` — spine-check every `<root>/projects/*.yaml`; exit 1 on any issue.
- `publish` — bundle the local catalog and upload to `s3://<bucket>/<key>`. `--dry-run` previews the bundle (stdout, or `--out <path>`) with no S3 call. The safe loop is `pull` → edit → `publish`: `publish` refuses without a `.catalogit-state.json` ETag baseline (exit 5) unless `--force`.
- `pull` — download the deployed bundle, sync local project YAMLs, and write the `.catalogit-state.json` baseline.
- `add` / `discover` — draft new project entries (a single `owner/repo`, or a GitHub owner's repos). **Both require the `gh` CLI and a coding agent (`codex` or `claude`) on `PATH`.**

`publish` and `pull` honor `AWS_ENDPOINT_URL` for custom S3 endpoints (LocalStack, MinIO) and switch to path-style addressing automatically. Note the AWS SDK prefers an ambient `AWS_PROFILE` over `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — unset it (`env -u AWS_PROFILE catalogit publish …`) when running against LocalStack with dummy credentials.

## Test scaffolding

catalogit is the lowest layer in the suite (no agent-runtime dependency).
The single public surface (`@leanish/catalog-it`) exports everything tests
need — including `InMemoryCatalog` and `isEnabledForConsumer` — so there
are no sub-entrypoints here.
