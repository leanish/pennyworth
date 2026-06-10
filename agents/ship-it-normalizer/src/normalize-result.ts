import type { ConsumerCatalogView } from "@leanish/catalog-it";
import type { ShipItRequest } from "@leanish/ship-it";

/**
 * Shared normalize plumbing: the result shape both normalizers return and
 * the strict catalog opt-in gate they both apply.
 */

/** Consumer id under which projects opt in (`extensions.ship-it`). */
export const SHIP_IT_CONSUMER_ID = "ship-it";

/**
 * Outcome of a normalize+gate pass (shared by `normalize-jira.ts` and
 * `normalize-github.ts`).
 *
 *   - `normalized` — every gate passed; the handler signs and sends.
 *   - `filtered`   — a gate said no. NOT an error: the handler logs the
 *     structured `reason`/`detail` and answers 204 so the provider stops
 *     retrying. Errors (bad signature, malformed JSON, send failure) are
 *     handled in `handler.ts`, not modelled here.
 */
export type NormalizeResult =
  | {
      readonly outcome: "normalized";
      readonly request: ShipItRequest;
      /** End-user identity for the envelope, e.g. `jira:<accountId>` / `github:<login>`. */
      readonly endUser: string;
    }
  | {
      readonly outcome: "filtered";
      /** Machine-readable gate name, e.g. `not-opted-in`, `draft-pr`. */
      readonly reason: string;
      /** Extra structured context for the log line. Never contains secrets. */
      readonly detail?: Readonly<Record<string, unknown>>;
    };

export function filtered(
  reason: string,
  detail?: Readonly<Record<string, unknown>>,
): NormalizeResult {
  return { outcome: "filtered", reason, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * STRICT catalog opt-in: the project must exist in ship-it's consumer
 * catalog view (`forConsumer("ship-it")`, which already drops explicit
 * `enabled: false`) AND carry an explicit `extensions["ship-it"].enabled
 * === true`. Stricter than the catalog's default-on consumer filter,
 * deliberately — ship-it is write-capable, so an absent flag means "not
 * opted in". Mirrors the in-handler gate in `@leanish/ship-it` (defense
 * in depth runs on both ends).
 */
export function isShipItOptedIn(view: ConsumerCatalogView, projectId: string): boolean {
  const project = view.get(projectId);
  if (project === undefined) return false;
  const slice = project.extensions[SHIP_IT_CONSUMER_ID];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) return false;
  return (slice as Record<string, unknown>)["enabled"] === true;
}
