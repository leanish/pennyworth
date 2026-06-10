import { describe, expect, it } from "vitest";

import * as catalogit from "../../src/index.js";

/**
 * Smoke test for the package's public surface. Asserts every key export is
 * present + callable shape. Catches accidental removal of exports or a
 * `dist/` shape regression before downstream agents see "import failed".
 */
const EXPECTED_VALUES = [
  "isEnabledForConsumer",
  "FilesystemCatalog",
  "InMemoryCatalog",
  "S3Catalog",
  "parseProjectYaml",
  "parseBundle",
  "bundleCatalog",
  "publishCatalog",
  "catalogitCli",
] as const;

describe("@leanish/catalog-it package exports", () => {
  it("exports every documented value at the public surface", () => {
    for (const name of EXPECTED_VALUES) {
      expect(catalogit, `missing export: ${name}`).toHaveProperty(name);
      expect(
        typeof (catalogit as Record<string, unknown>)[name],
        `export ${name} should be a callable (function / class)`,
      ).toBe("function");
    }
  });

  it("InMemoryCatalog is constructable and satisfies CatalogReadOnly", () => {
    const catalog = new catalogit.InMemoryCatalog([]);
    expect(catalog.list()).toEqual([]);
    expect(catalog.get("none")).toBeUndefined();
    expect(catalog.forConsumer("any").list()).toEqual([]);
  });

  it("bundleCatalog returns a non-empty string for an empty catalog", () => {
    expect(catalogit.bundleCatalog([])).toBe(`{"version":"1","projects":[]}`);
  });
});
