import {
  EventBridgeClient as AwsEventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";

import { awsClientDefaults } from "../aws-mode/client-config.js";
import type {
  EventBridgeClient,
  PutEventsRequest,
  PutEventsResult,
} from "../types/clients.js";

import type { NeedFactoryContext, NeedSpec } from "./spec.js";

/**
 * `eventbridge` need. Provides `runtime.clients.eventbridge.putEvents(...)`.
 *
 * Env vars:
 *   - `EVENT_BUS_NAME` (required) — name of the EventBridge custom bus to
 *     publish to. ATC sets this to `atc-events`.
 */
export const eventbridgeNeed: NeedSpec<EventBridgeClient> = {
  name: "eventbridge",
  envVars: [
    {
      name: "EVENT_BUS_NAME",
      description: "EventBridge custom bus name for outbound events.",
    },
  ],
  iamActions: ["events:PutEvents"],
  awsFactory(ctx) {
    return buildEventBridgeClient({
      ctx,
      requireBusName: true,
      async send(entries) {
        const client = new AwsEventBridgeClient({
          ...awsClientDefaults(),
          region: ctx.region,
        });
        // Debug breadcrumb. ConsoleLogger picks up AsyncLocalStorage
        // correlation context on every emit, so the AWS call appears in
        // CloudWatch with the originating requestId / sourceTrigger / stage.
        ctx.logger.debug("eventbridge.putEvents", { entries: entries.length });
        try {
          return await client.send(new PutEventsCommand({ Entries: entries }));
        } catch (err) {
          ctx.logger.warn("eventbridge.putEvents failed", {
            entries: entries.length,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    });
  },
  localFactory(ctx) {
    return buildEventBridgeClient({
      ctx,
      // Local-mode `putEvents` is a no-op; we don't require EVENT_BUS_NAME
      // so `atc-dev-publish | agent-runtime run-local` works without env setup.
      requireBusName: false,
      async send(entries) {
        ctx.logger.info("local-mode eventbridge.putEvents (no-op)", {
          entries: entries.length,
        });
        return { FailedEntryCount: 0 };
      },
    });
  },
};

interface EventBridgeBackend {
  send(entries: PutEventsRequestEntry[]): Promise<{ FailedEntryCount?: number | undefined }>;
}

function buildEventBridgeClient(args: {
  readonly ctx: NeedFactoryContext;
  readonly requireBusName: boolean;
  readonly send: EventBridgeBackend["send"];
}): EventBridgeClient {
  const busName = args.ctx.env["EVENT_BUS_NAME"] ?? "local";
  return {
    async putEvents(request: PutEventsRequest): Promise<PutEventsResult> {
      if (args.requireBusName && args.ctx.env["EVENT_BUS_NAME"] === undefined) {
        throw new Error(
          "eventbridge.putEvents called but EVENT_BUS_NAME is not set in the runtime environment",
        );
      }
      const entries: PutEventsRequestEntry[] = request.entries.map((e) => {
        const entry: PutEventsRequestEntry = {
          EventBusName: busName,
          Source: e.source,
          DetailType: e.detailType,
          Detail: JSON.stringify(e.detail),
        };
        if (e.resources !== undefined) {
          entry.Resources = [...e.resources];
        }
        return entry;
      });
      const result = await args.send(entries);
      return { failedCount: result.FailedEntryCount ?? 0 };
    },
  };
}
