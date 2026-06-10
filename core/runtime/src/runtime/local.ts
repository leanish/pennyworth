/**
 * `@leanish/runtime/local` — local-mode helpers re-exported under
 * a separate subpath so downstream agents can compose a one-shot harness
 * without pulling the AWS-mode adapters into their own bundle.
 *
 * Use this sub-entrypoint when you're building a local-mode invocation
 * shim (a script that drives an agent against fakes); use the main entry
 * (`@leanish/runtime`) when you need the full surface including
 * AWS-mode adapters.
 */

// CLI surface — what the `bin/agent-runtime.js` shebang script invokes.
export { runLocalCli, type RunLocalCliOptions } from "./run-local-cli.js";

// Programmatic local-mode dispatch — equivalent to what the CLI does internally.
export { runLocal, type RunLocalOptions } from "./run-local.js";

// The injected-Runtime builder. Pass local-mode catalog/workspace/clients
// and a FakeCodingAgentRunner to drive the dispatch loop without AWS.
export { buildRuntime, type BuildRuntimeOptions } from "./build-runtime.js";

// Local-mode catalog readers (filesystem + in-memory).
export {
  FilesystemCatalog,
  type FilesystemCatalogOptions,
  InMemoryCatalog,
  parseProjectYaml,
  isEnabledForConsumer,
  type Project,
  type ProjectSource,
  type CatalogReadOnly,
  type ConsumerCatalogView,
} from "@leanish/catalog-it";

// Local-mode workspaces.
export { LocalGitWorkspace, type LocalGitWorkspaceOptions } from "../working-copy/local-git-workspace.js";
export { InMemoryWorkspace, type InMemoryWorkspaceOptions } from "../working-copy/in-memory-workspace.js";
export type { Workspace } from "../working-copy/workspace.js";
