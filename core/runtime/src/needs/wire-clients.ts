import { MissingNeedError } from "../errors.js";
import type { Clients } from "../types/clients.js";
import type { Logger } from "../types/logger.js";

import { needSpecs } from "./registry.js";

/**
 * Build the `runtime.clients` object an agent will see. Each declared need
 * gets a wired client from the registry; everything else is gated by a
 * Proxy that throws `MissingNeedError` on access.
 *
 * Returns a frozen Proxy of `Clients` whose property reads:
 *   - declared need + wired client → returns the client;
 *   - declared need + not in registry → throws (developer error in needSpecs);
 *   - undeclared need → throws `MissingNeedError`.
 *
 * `clientOverrides` lets tests / advanced callers replace individual
 * clients (e.g. a stub `eventbridge` for a unit test). Overrides take
 * precedence over registry factories.
 */
export type ClientMode = "aws" | "local";

export interface WireClientsArgs {
  readonly mode: ClientMode;
  readonly needs: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly region: string;
  readonly logger: Logger;
  readonly clientOverrides?: Partial<Clients>;
}

export function wireClients(args: WireClientsArgs): Clients {
  const declared = new Set(args.needs);
  const backing: Partial<Clients> = { ...(args.clientOverrides ?? {}) };

  for (const need of declared) {
    const key = need as keyof Clients;
    if (backing[key] !== undefined) continue; // override wins
    const spec = needSpecs.get(need);
    if (spec === undefined) {
      // Surfaced at startup via descriptor validation; defensive here.
      throw new Error(
        `wireClients: unknown need '${need}' (not present in needSpecs registry)`,
      );
    }
    const ctx = { env: args.env, region: args.region, logger: args.logger };
    const client = args.mode === "aws" ? spec.awsFactory(ctx) : spec.localFactory(ctx);
    (backing as Record<string, unknown>)[need] = client;
  }

  return gateClientsByNeeds(args.needs, backing as Clients);
}

/**
 * Wrap `clients` in a Proxy that throws `MissingNeedError` when handler code
 * reads a property not in `needs:`. Declared-but-unwired access returns the
 * underlying property (likely `undefined`) — the existing developer-error
 * path. Shared by `wireClients` (gates its own output) and `buildRuntime`
 * (gates whatever clients it's handed); each layer guards its own boundary,
 * so this is the single source for the trap.
 */
export function gateClientsByNeeds(
  needs: ReadonlyArray<string>,
  clients: Clients,
): Clients {
  const declared = new Set(needs);
  return new Proxy(clients, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (!declared.has(prop)) {
        throw new MissingNeedError(prop);
      }
      return (target as Record<string, unknown>)[prop];
    },
  });
}
