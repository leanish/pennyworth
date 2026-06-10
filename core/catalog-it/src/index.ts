// Public API for `@leanish/catalog-it`.

export {
  CatalogLoadError,
  CatalogIoError,
  type CatalogLoadIssue,
} from "./errors.js";
export type { Project, ProjectSource } from "./project.js";
export type { CatalogReadOnly, ConsumerCatalogView } from "./catalog.js";
export { isEnabledForConsumer } from "./consumer-filter.js";
export {
  FilesystemCatalog,
  type FilesystemCatalogOptions,
  parseProjectYaml,
} from "./filesystem-catalog.js";
export { InMemoryCatalog } from "./in-memory-catalog.js";
export {
  S3Catalog,
  type S3CatalogOptions,
  type CatalogBundle,
  parseBundle,
} from "./s3-catalog.js";
export { bundleCatalog, type BundleOptions } from "./bundle.js";
export {
  publishCatalog,
  type PublishCatalogArgs,
  type PublishCatalogResult,
} from "./publish.js";
export { catalogitCli, type CatalogitCliOptions } from "./cli.js";
export {
  validateCatalog,
  type CatalogValidationIssue,
  type ValidateCatalogArgs,
  type ValidateCatalogResult,
} from "./validate.js";
