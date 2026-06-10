import type { CatalogReadOnly, ConsumerCatalogView } from "./catalog.js";
import { isEnabledForConsumer } from "./consumer-filter.js";
import type { Project } from "./project.js";

/**
 * Trivial in-memory catalog backing — useful in tests and for synthetic
 * fixtures. Shares the consumer-filter convention with the other
 * implementations so behaviour is consistent.
 */
export class InMemoryCatalog implements CatalogReadOnly {
  readonly #projects: ReadonlyMap<string, Project>;

  constructor(projects: ReadonlyArray<Project>) {
    const map = new Map<string, Project>();
    for (const project of projects) {
      map.set(project.id, project);
    }
    this.#projects = map;
  }

  list(): ReadonlyArray<Project> {
    return [...this.#projects.values()];
  }

  get(id: string): Project | undefined {
    return this.#projects.get(id);
  }

  forConsumer(consumerId: string): ConsumerCatalogView {
    const enabled = this.list().filter((project) =>
      isEnabledForConsumer(project, consumerId),
    );
    return {
      list: () => enabled,
      get: (id: string) => enabled.find((project) => project.id === id),
    };
  }
}
