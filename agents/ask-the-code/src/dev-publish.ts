import { createHmac, randomUUID } from "node:crypto";
import { parseArgs as nodeParseArgs } from "node:util";

import {
  canonicalize,
  envelopeToRuntimeMessage,
  type SignedEnvelope,
} from "@leanish/runtime";

import type { AtcRequest } from "./request-schema.js";

/**
 * `atc-dev-publish` — generate an ATC envelope ready for piping into
 * `agent-runtime run-local`. Local-mode smoke test that requires no AWS
 * resources and no real consumer registry.
 *
 * Default output: a `RuntimeMessage<AtcPayload>` JSON object on stdout.
 * `--envelope-only` switches to outputting the signed wire envelope
 * (useful for exercising the Lambda shim's verification path against a
 * matching consumer registry).
 *
 * Example:
 *
 *   atc-dev-publish --question "what does auth do?" --project-ids leanish/atc \
 *     | agent-runtime run-local --agent-config ./agent.yaml --fake-runner
 */
export interface DevPublishCliOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Override for tests; defaults to `() => new Date().toISOString()`. */
  readonly clock?: () => string;
  /** Override for tests; defaults to `randomUUID`. */
  readonly newRequestId?: () => string;
}

export async function devPublishCli(
  argv: ReadonlyArray<string>,
  options: DevPublishCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const clock = options.clock ?? (() => new Date().toISOString());
  const newRequestId = options.newRequestId ?? (() => randomUUID());

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout.write(USAGE);
    return 0;
  }

  let args: DevPublishArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const request = buildAtcRequest(args);
  const envelope = buildSignedEnvelope({ args, request, clock, newRequestId });

  if (args.envelopeOnly) {
    stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return 0;
  }

  const message = envelopeToRuntimeMessage(envelope, {
    sqsMessageId: args.sqsMessageId ?? `local-${randomUUID()}`,
    receivedAt: clock(),
  });
  stdout.write(JSON.stringify(message, null, 2) + "\n");
  return 0;
}

interface DevPublishArgs {
  readonly question: string;
  readonly consumer: string;
  readonly endUser: string;
  readonly requestId?: string;
  readonly conversationKey?: string;
  readonly replyTo?: string;
  readonly projectIds?: ReadonlyArray<string>;
  readonly includeAll?: boolean;
  readonly audience?: "general" | "codebase";
  readonly noSync?: boolean;
  readonly scopeOnly?: boolean;
  readonly signingSecret: string;
  readonly sqsMessageId?: string;
  readonly envelopeOnly: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): DevPublishArgs {
  const { values } = nodeParseArgs({
    args: [...argv],
    options: {
      "question": { type: "string" },
      "consumer": { type: "string", default: "atc-ui" },
      "end-user": { type: "string", default: "local:dev" },
      "request-id": { type: "string" },
      "conversation-key": { type: "string" },
      "reply-to": { type: "string" },
      "project-ids": { type: "string" },
      "include-all": { type: "boolean", default: false },
      "audience": { type: "string" },
      "no-sync": { type: "boolean", default: false },
      "scope-only": { type: "boolean", default: false },
      "signing-secret": { type: "string" },
      "sqs-message-id": { type: "string" },
      "envelope-only": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const question = values["question"];
  if (question === undefined) throw new Error("--question is required");

  const signingSecret = values["signing-secret"] ?? process.env["ATC_DEV_CONSUMER_SECRET"];
  if (signingSecret === undefined || signingSecret.length === 0) {
    throw new Error(
      "--signing-secret is required (or set $ATC_DEV_CONSUMER_SECRET). " +
        "atc-dev-publish has no built-in default so a real secret can never accidentally land in committed code.",
    );
  }

  const audienceRaw = values["audience"];
  let audience: "general" | "codebase" | undefined;
  if (audienceRaw !== undefined) {
    if (audienceRaw !== "general" && audienceRaw !== "codebase") {
      throw new Error(`--audience must be 'general' or 'codebase' (got '${audienceRaw}')`);
    }
    audience = audienceRaw;
  }

  const projectIdsRaw = values["project-ids"];
  const projectIds =
    projectIdsRaw === undefined
      ? undefined
      : projectIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

  const requestId = values["request-id"];
  const conversationKey = values["conversation-key"];
  const replyTo = values["reply-to"];
  const sqsMessageId = values["sqs-message-id"];

  return {
    question,
    consumer: values["consumer"] ?? "atc-ui",
    endUser: values["end-user"] ?? "local:dev",
    signingSecret,
    envelopeOnly: values["envelope-only"] === true,
    noSync: values["no-sync"] === true,
    scopeOnly: values["scope-only"] === true,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(conversationKey !== undefined ? { conversationKey } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(projectIds !== undefined ? { projectIds } : {}),
    ...(values["include-all"] === true ? { includeAll: true } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(sqsMessageId !== undefined ? { sqsMessageId } : {}),
  };
}

function buildAtcRequest(args: DevPublishArgs): AtcRequest {
  return {
    question: args.question,
    ...(args.audience !== undefined ? { audience: args.audience } : {}),
    ...(args.projectIds !== undefined && args.projectIds.length > 0
      ? { projectIds: args.projectIds }
      : {}),
    ...(args.includeAll !== undefined ? { includeAll: args.includeAll } : {}),
    ...(args.noSync ? { noSync: true } : {}),
    ...(args.scopeOnly ? { scopeOnly: true } : {}),
  };
}

function buildSignedEnvelope(ctx: {
  readonly args: DevPublishArgs;
  readonly request: AtcRequest;
  readonly clock: () => string;
  readonly newRequestId: () => string;
}): SignedEnvelope {
  const timestamp = ctx.clock();
  const requestId = ctx.args.requestId ?? ctx.newRequestId();
  const payload = ctx.request as unknown as Record<string, unknown>;
  const signature = sign({
    secret: ctx.args.signingSecret,
    timestamp,
    consumer: ctx.args.consumer,
    endUser: ctx.args.endUser,
    payload,
    ...(ctx.args.conversationKey !== undefined
      ? { conversationKey: ctx.args.conversationKey }
      : {}),
  });
  return {
    kind: "ask",
    requestId,
    consumer: ctx.args.consumer,
    endUser: ctx.args.endUser,
    timestamp,
    signature,
    payload,
    ...(ctx.args.conversationKey !== undefined
      ? { conversationKey: ctx.args.conversationKey }
      : {}),
    ...(ctx.args.replyTo !== undefined ? { replyTo: ctx.args.replyTo } : {}),
  };
}

function sign(args: {
  readonly secret: string;
  readonly timestamp: string;
  readonly consumer: string;
  readonly endUser: string;
  readonly conversationKey?: string;
  readonly payload: Record<string, unknown>;
}): string {
  const message =
    args.timestamp +
    "\n" +
    args.consumer +
    "\n" +
    args.endUser +
    "\n" +
    (args.conversationKey ?? "") +
    "\n" +
    canonicalize(args.payload);
  // Treat the secret as a UTF-8 string; consumers that store a base64-encoded
  // key should pass `--signing-secret "$(base64 -d <<< $KEY)"` or similar. For
  // the local-dev default, a literal string is exactly what the matching
  // local ConsumerRegistry should compare against.
  return createHmac("sha256", args.secret).update(message).digest("hex");
}

const USAGE = `Usage:
  atc-dev-publish --question <text>
                  [--consumer <id>]            default: atc-ui
                  [--end-user <ref>]           default: local:dev
                  [--request-id <uuid>]        default: random
                  [--conversation-key <key>]
                  [--reply-to <sqs-arn>]
                  [--project-ids a,b,c]
                  [--include-all]
                  [--audience general|codebase]
                  [--no-sync]
                  [--scope-only]
                  --signing-secret <key>       required (or $ATC_DEV_CONSUMER_SECRET)
                  [--sqs-message-id <id>]      default: local-<uuid>
                  [--envelope-only]            print the wire envelope instead of RuntimeMessage

Pipe the output into 'agent-runtime run-local' (it reads the message from stdin) for a local-mode smoke test:

  atc-dev-publish --question "what does auth do?" \\
    | agent-runtime run-local --agent-config ./agent.yaml --fake-runner
`;
