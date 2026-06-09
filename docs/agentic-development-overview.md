# agentic-development

Implementation home for the leanish agent suite. Phase-1 ships **three** packages (`catalogit`, `agent-runtime`, `agent-atc`); `agent-secureit` is a phase-2 placeholder colocated for shape continuity. Per suite-0004 each is its own deployable.

Specs live at `../specs/` (canonical, suite-wide); this directory is the code that implements them. Implementation-side acceptance criteria are listed in `./PHASE-1-ACCEPTANCE.md`.

## Layout

```
agentic-development/
├── catalogit/          @leanish/catalogit       — catalog read-side library + CLI (phase 1)
├── agent-runtime/      @leanish/agent-runtime   — shared runtime library + run-local CLI (phase 1)
├── agent-atc/          @leanish/agent-atc       — ATC Q&A Layer-3 agent + dev-publish CLI (phase 1)
└── agent-secureit/     @leanish/agent-secureit  — phase-2 placeholder (NOT in phase-1 acceptance)
```

Each package has its own `package.json` / `tsconfig.json` / `vitest.config.ts` / `AGENTS.md` / `README.md`. They are **not** an npm workspace — each is independent and could move to its own git repo without restructuring.

Dependency graph:

```
agent-atc      ──► agent-runtime ──► catalogit
agent-secureit ──► agent-runtime ──► catalogit   (phase-2 placeholder)
catalogit      ──► (nothing in this suite)
```

Local-dev linkage is via `file:../<sibling>` in each consumer's `package.json`. Build order: `catalogit` → `agent-runtime` → agents.

## Status (phase-1 release candidate)

| Project | Status | Tests |
|---|---|---|
| `catalogit` | **Phase-1 complete.** `Project` / `ProjectSource` types (no `kind` discriminator — a future addition is a schema-major bump per ADR-0014's strict-by-default loader), `CatalogReadOnly` / `ConsumerCatalogView` interfaces, default-on `isEnabledForConsumer` filter, `FilesystemCatalog` + `S3Catalog` + `InMemoryCatalog` readers (all strict: unknown spine fields throw), deterministic `bundleCatalog` (recursive key sort), S3 `publishCatalog`, **`catalogit` CLI (`validate`, `publish` [`--dry-run` previews the bundle], `pull`, `add`, `discover`)** using Node 24's `util.parseArgs`. | 122 passing |
| `agent-runtime` | **Phase-1 complete.** Dispatcher with `withCorrelation` wiring **and terminal-reply propagation**, real `ClaudeCodeRunner` + `CodexRunner` subprocesses with **multi-WC mount via `--add-dir`** and `effort` threading on Codex, **async `buildRuntime` with the schema-subset compat gate folded in** (custom entry shims get the same check), `run-local` CLI returning the handler's terminal reply, needs-wired clients (eventbridge / sqs / s3, permissive local-mode) with **shared `awsClientDefaults()` retry config**, envelope verification (canonical-JSON HMAC + allowedKinds + clock skew), AWS-mode adapters (DynamoIdempotencyStore / DynamoConsumerRegistry / S3Catalog), SQS Lambda entry shim with per-record `SqsRecordStatus` enum (incl. `handled-stale-complete`) alongside `batchItemFailures`, **idempotency freshness guard on `complete()` / `expire()`** (ADR-0006), secret redaction. `FakeCodingAgentRunner` defaults to **strict** ("throw on unregistered"); synthesised responses are opt-in (`run-local --fake-runner` opts in for smoke-test ergonomics). Phase-2 helpers (`runtime.publish` / `publishDelayed`) are **deliberately absent** from the phase-1 `Runtime` interface — downstream agents reaching for them get a compile-time error, not a runtime throw. Sub-entrypoints: `@leanish/agent-runtime/local`, `@leanish/agent-runtime/testing` (now exports `InMemoryEventBus` + `InMemorySqsBus` for assertable test emissions). | 143 passing |
| `agent-atc` | **Phase-1 complete.** Six-step transformation, ordered lifecycle protocol (started → project-resolution emitted before scope-composition, working-copy-sync, coding-agent-execution → completed/failed) with **error-level logging** on emission failure and **duplicate-stage emission throwing `LifecycleProgrammingError`** (mapped to terminal `config-error`). Terminal reply is **complete-shape** (required `answer`/`projectScope`/`syncReport`/`agent`/`durationMs`) in both full and scope-only paths. **Unknown projectIds throw** (validation-error); **missing router throws** config-error (no silent fallback). `atc-dev-publish` bin for local-mode smoke tests — **`--signing-secret` is required** (or `$ATC_DEV_CONSUMER_SECRET`), no built-in default. Ships a concrete AWS Lambda entry module (`src/lambda.ts`, exported as `@leanish/agent-atc/lambda`) that builds Dynamo idempotency + Dynamo consumer registry + S3 catalog + `LocalGitWorkspace` and exposes `atcLambdaHandler` for `agent-infra` to register. | 39 passing |
| `agent-secureit` | **Phase-2 placeholder — types only.** No handler. Locks the descriptor + per-stage payload contract for phase-2; ships zero runtime behavior. See `agent-secureit/SCOPE.md`. | 3 passing |

**Phase-1 release-candidate total: 307 tests across 4 packages, all green.**

## Working with all four

```bash
# from agentic-development/, with the canonical phase-1 check script:
( cd catalogit     && npm install && npm run check )
( cd agent-runtime && npm install && npm run check )
( cd agent-atc    && npm install && npm run check )
( cd agent-secureit && npm install && npm run check )
```

`npm run check` runs `typecheck && build && test`. After editing `catalogit/`, rebuild it then refresh `agent-runtime/`'s install; after editing `agent-runtime/`, rebuild it then refresh each agent's install. The `file:` deps copy the dist tree, so a rebuild of an upstream package only reaches downstream installs after `npm install` re-runs.

## Local-mode smoke test

ATC's `atc-dev-publish` bin generates a `RuntimeMessage<AtcPayload>` you can pipe into `agent-runtime`'s `run-local`. **The runtime now prints ATC's terminal reply directly on stdout** — no `{status:ok}` wrapper. No AWS resources, no env setup beyond the default.

Build the three packages first (see *Working with all four* above) — the commands below run the compiled `dist/bin/` entrypoints. The shortest path is `agent-atc`'s ready-made script, which wires the whole pipe (defaulting `ATC_DEV_CONSUMER_SECRET=local-dev`):

```bash
( cd agent-atc && npm run smoke:local )
```

```bash
# Full skill-execution path: --fake-runner synthesises a schema-valid response
# from the `ask` skill's outputSchema, so the pipe succeeds end-to-end.
( cd agent-atc && \
  ATC_DEV_CONSUMER_SECRET=local-dev \
  node dist/bin/atc-dev-publish.js \
    --question "what does auth do?" \
    --include-all \
  | node ../agent-runtime/dist/bin/agent-runtime.js run-local \
    --agent-config ./agent.yaml \
    --fake-runner \
    --log-level error )
# → {"requestId":"...","status":"completed","result":{"answer":"fake-fixture",
#    "projectScope":{...},"syncReport":[],"agent":{...},"durationMs":...}}
```

Drop `--fake-runner` to spawn a real `claude` (or `codex`) CLI subprocess; that path requires the CLI on `PATH` and is gated by `--coding-agent` resolution in the descriptor.

## Catalog operator workflow

`catalogit` ships a CLI for inspecting, validating, and deploying catalogs:

```bash
# Spine-check every project YAML (exits non-zero on any issue, with file paths):
catalogit validate --catalog-root ~/.local/share/catalogit

# Preview the deterministic JSON bundle that publish would upload (no S3 write):
catalogit publish --dry-run --catalog-root ~/.local/share/catalogit

# Safe publish: pull the live bundle first (writes a .catalogit-state.json ETag
# baseline), edit, then publish. publish refuses without that baseline (exit 5)
# unless you pass --force. Both use the default AWS credential chain:
catalogit pull \
  --catalog-root ~/.local/share/catalogit \
  --bucket leanish-catalog --region us-east-1
catalogit publish \
  --catalog-root ~/.local/share/catalogit \
  --bucket leanish-catalog --region us-east-1
```

The bundle is byte-deterministic — same input always produces the same JSON, so `catalogit publish --dry-run` is a clean preview of exactly what `publish` would upload.

## Suite carry-overs

See each project's `AGENTS.md` for the rules. Top-line: American English, no `codex` in commits / PR titles, employer-neutral, never commit without explicit ask.
