import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as runtime from "../../src/index.js";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Smoke test for the package's public surface. Asserts every key export is
 * present + callable. Catches accidental removal of exports or a `dist/`
 * shape regression before downstream agents see "import failed".
 */
const EXPECTED_VALUES = [
  // Entry
  "defineAgent",
  // Constants
  "STAGES",
  "isStage",
  "SOURCE_TRIGGERS",
  "isSourceTrigger",
  "EFFORTS",
  // AWS-mode entry shim + shared client config
  "createSqsLambdaShim",
  "awsClientDefaults",
  // Runtime + runner construction (needed by Lambda entry modules)
  "buildRuntime",
  "ClaudeCodeRunner",
  "CodexRunner",
  // Descriptor loader
  "loadDescriptorFromFile",
  "parseDescriptor",
  // Workspaces
  "LocalGitWorkspace",
  "InMemoryWorkspace",
  // Logger
  "ConsoleLogger",
  // Envelope primitives
  "verifyEnvelope",
  "canonicalize",
  "envelopeToRuntimeMessage",
  // Consumer registry (memory + AWS)
  "MemoryConsumerRegistry",
  "DynamoConsumerRegistry",
  // Idempotency stores
  "MemoryIdempotencyStore",
  "DynamoIdempotencyStore",
  // Catalog readers (re-exported from @leanish/catalog-it)
  "FilesystemCatalog",
  "InMemoryCatalog",
  "S3Catalog",
  "parseProjectYaml",
  "parseBundle",
  "isEnabledForConsumer",
  // Needs
  "needSpecs",
  "getNeedSpec",
  "wireClients",
  // Errors
  "DescriptorValidationError",
  "EntrypointInvocationError",
  "EntrypointSchemaError",
  "EnvelopeVerificationError",
  "ExecutionResolveError",
  "MissingNeedError",
  "PhaseUnavailableError",
  "RouterNotConfiguredError",
  "RuntimeError",
  "UnhandledStageError",
] as const;

describe("@leanish/runtime package exports", () => {
  it("exports every documented value at the public surface", () => {
    for (const name of EXPECTED_VALUES) {
      expect(runtime, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("STAGES contains the canonical phase-1 + phase-2 stages", () => {
    expect(runtime.STAGES).toEqual(["init", "breakdown", "revisit"]);
  });

  it("SOURCE_TRIGGERS contains the phase-1 + phase-2+ vocabulary", () => {
    expect(runtime.SOURCE_TRIGGERS).toContain("consumer");
    expect(runtime.SOURCE_TRIGGERS).toContain("scheduler");
    expect(runtime.SOURCE_TRIGGERS).toContain("self");
  });

  it("needSpecs registers s3 + eventbridge + sqs + github", () => {
    expect(runtime.needSpecs.has("s3")).toBe(true);
    expect(runtime.needSpecs.has("eventbridge")).toBe(true);
    expect(runtime.needSpecs.has("sqs")).toBe(true);
    expect(runtime.needSpecs.has("github")).toBe(true);
  });

  it("defineAgent returns the same object unchanged", () => {
    const def = { identifier: "x", async handle() {} };
    expect(runtime.defineAgent(def)).toBe(def);
  });
});

/**
 * Build-shape smoke: every declared `package.json#exports` subpath MUST
 * point at a file that exists in `dist/` after `npm run build`. This
 * catches the historical bug where `./local` and `./testing` were
 * declared but their target files didn't exist; consumers got
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime.
 *
 * For each subpath, we also `import()` it at runtime so a bad re-export
 * surfaces here rather than in some downstream agent's CI.
 */
describe("package.json#exports resolves end-to-end", () => {
  const pkgJson = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, { types?: string; import?: string }> };

  const subpathEntries = Object.entries(pkgJson.exports);

  it.each(subpathEntries)(
    "subpath %s: declared 'import' and 'types' files exist on disk",
    (_subpath, target) => {
      if (target.import !== undefined) {
        const importPath = join(PACKAGE_ROOT, target.import);
        expect(existsSync(importPath), `missing: ${importPath}`).toBe(true);
      }
      if (target.types !== undefined) {
        const typesPath = join(PACKAGE_ROOT, target.types);
        expect(existsSync(typesPath), `missing: ${typesPath}`).toBe(true);
      }
    },
  );

  it.each(subpathEntries)(
    "subpath %s: can be import()-ed at runtime",
    async (_subpath, target) => {
      if (target.import === undefined) return;
      const importPath = join(PACKAGE_ROOT, target.import);
      const mod = (await import(importPath)) as Record<string, unknown>;
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    },
  );
});
