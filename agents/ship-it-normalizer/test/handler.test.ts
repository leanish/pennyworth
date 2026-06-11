import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifyEnvelope, type Logger } from "@leanish/runtime";
import { InMemoryCatalog, MemoryConsumerRegistry } from "@leanish/runtime/testing";
import { parseShipItRequest } from "@leanish/ship-it";

import { InMemoryTtlDedupeStore } from "../src/dedupe.js";
import { createNormalizerHandler, type NormalizerHandlerOptions } from "../src/handler.js";
import type { FunctionUrlEvent } from "../src/http.js";
import { PR_READY_FOR_REVIEW_STATUS } from "../src/normalize-github.js";
import { SqsEnvelopeSender, type SqsSendClient } from "../src/sender.js";

const GITHUB_SECRET = "github-webhook-secret";
const JIRA_SECRET = "jira-shared-secret";
const SIGNING_KEY_BASE64 = Buffer.from("normalizer-signing-key-bytes").toString("base64");
const SIGNING_KEY = Buffer.from(SIGNING_KEY_BASE64, "base64");
const QUEUE_URL = "https://sqs.example.test/000000000000/ship-it-input";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  with() {
    return this;
  },
};

const CATALOG = new InMemoryCatalog([
  {
    id: "acme/widgets",
    source: { url: "https://github.com/acme/widgets.git", branch: "main" },
    extensions: { "ship-it": { enabled: true } },
  },
  {
    id: "acme/legacy",
    source: { url: "https://github.com/acme/legacy.git", branch: "main" },
    extensions: { "ship-it": { enabled: false } },
  },
  {
    id: "acme/implicit",
    source: { url: "https://github.com/acme/implicit.git", branch: "main" },
    extensions: {},
  },
]);

const PROJECT_MAP = { ABC: "acme/widgets", LEG: "acme/legacy", IMP: "acme/implicit" } as const;

class CapturingSqsClient implements SqsSendClient {
  readonly sent: SendMessageCommand[] = [];

  async send(command: SendMessageCommand): Promise<unknown> {
    this.sent.push(command);
    return {};
  }
}

function createTestHandler(overrides: Partial<NormalizerHandlerOptions> = {}) {
  const sqs = new CapturingSqsClient();
  const handler = createNormalizerHandler({
    githubWebhookSecret: GITHUB_SECRET,
    jiraWebhookSecret: JIRA_SECRET,
    envelopeSigningKey: SIGNING_KEY,
    catalog: CATALOG,
    jiraProjectMap: PROJECT_MAP,
    jiraAcceptanceFieldId: "customfield_10042",
    dedupe: new InMemoryTtlDedupeStore(),
    sender: new SqsEnvelopeSender({ queueUrl: QUEUE_URL, client: sqs }),
    logger: noopLogger,
    ...overrides,
  });
  return { handler, sqs };
}

function sentEnvelope(sqs: CapturingSqsClient, index = 0): Record<string, unknown> {
  const command = sqs.sent[index];
  expect(command).toBeDefined();
  expect(command!.input.QueueUrl).toBe(QUEUE_URL);
  return JSON.parse(command!.input.MessageBody!) as Record<string, unknown>;
}

function githubSignature(raw: Buffer, secret = GITHUB_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

function githubEvent(
  body: unknown,
  options: { base64?: boolean; signature?: string; deliveryId?: string } = {},
): FunctionUrlEvent {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  return {
    rawPath: "/github",
    headers: {
      "x-hub-signature-256": options.signature ?? githubSignature(raw),
      "x-github-delivery": options.deliveryId ?? randomUUID(),
    },
    body: options.base64 === true ? raw.toString("base64") : raw.toString("utf8"),
    isBase64Encoded: options.base64 === true,
  };
}

function jiraEvent(body: unknown, options: { secret?: string | undefined } = {}): FunctionUrlEvent {
  return {
    rawPath: "/jira",
    headers: {
      ...(options.secret !== undefined ? { "x-leanish-webhook-secret": options.secret } : {}),
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "ready_for_review",
    pull_request: {
      number: 7,
      title: "ABC-123: implement the widget",
      draft: false,
      head: { ref: "ship-it/ABC-123" },
    },
    repository: { full_name: "acme/widgets" },
    sender: { login: "octocat" },
    ...overrides,
  };
}

function jiraIssueBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    webhookEvent: "jira:issue_updated",
    user: { accountId: "557058:abc" },
    issue: {
      key: "ABC-123",
      fields: {
        project: { key: "ABC" },
        status: { name: "Ready for Implementation" },
        labels: ["ship-it"],
        summary: "Implement the widget",
        description: "Make it spin",
        customfield_10042: ["AC-1", "AC-2"],
      },
    },
    ...overrides,
  };
}

describe("routing", () => {
  it("answers 404 on unknown paths", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler({ ...githubEvent(prBody()), rawPath: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(sqs.sent).toHaveLength(0);
  });
});

describe("github signature verification", () => {
  it("accepts a validly signed non-base64 Function URL event", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(githubEvent(prBody(), { base64: false }));
    expect(response.statusCode).toBe(202);
    expect(sqs.sent).toHaveLength(1);
  });

  it("accepts a validly signed base64-encoded Function URL event", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(githubEvent(prBody(), { base64: true }));
    expect(response.statusCode).toBe(202);
    expect(sqs.sent).toHaveLength(1);
  });

  it("rejects a tampered body with 401", async () => {
    const { handler, sqs } = createTestHandler();
    const signatureForOriginal = githubSignature(Buffer.from(JSON.stringify(prBody()), "utf8"));
    const tampered = prBody({ sender: { login: "mallory" } });
    const response = await handler(githubEvent(tampered, { signature: signatureForOriginal }));
    expect(response.statusCode).toBe(401);
    expect(sqs.sent).toHaveLength(0);
  });

  it("rejects a tampered base64 body with 401", async () => {
    const { handler, sqs } = createTestHandler();
    const signatureForOriginal = githubSignature(Buffer.from(JSON.stringify(prBody()), "utf8"));
    const response = await handler(
      githubEvent(prBody({ sender: { login: "mallory" } }), {
        base64: true,
        signature: signatureForOriginal,
      }),
    );
    expect(response.statusCode).toBe(401);
    expect(sqs.sent).toHaveLength(0);
  });

  it("rejects a missing signature header with 401", async () => {
    const { handler } = createTestHandler();
    const event = githubEvent(prBody());
    const response = await handler({
      ...event,
      headers: { "x-github-delivery": event.headers["x-github-delivery"] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed signature header with 401", async () => {
    const { handler } = createTestHandler();
    const event = githubEvent(prBody(), { signature: "sha256=not-hex-at-all" });
    expect((await handler(event)).statusCode).toBe(401);
    const noPrefix = githubEvent(prBody(), { signature: "deadbeef" });
    expect((await handler(noPrefix)).statusCode).toBe(401);
  });
});

describe("jira secret verification", () => {
  it("rejects a wrong shared secret with 401", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(jiraEvent(jiraIssueBody(), { secret: "wrong" }));
    expect(response.statusCode).toBe(401);
    expect(sqs.sent).toHaveLength(0);
  });

  it("rejects a missing shared-secret header with 401", async () => {
    const { handler } = createTestHandler();
    const response = await handler(jiraEvent(jiraIssueBody(), {}));
    expect(response.statusCode).toBe(401);
  });

  it("accepts the correct shared secret", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(jiraEvent(jiraIssueBody(), { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(202);
    expect(sqs.sent).toHaveLength(1);
  });
});

describe("strict catalog opt-in", () => {
  it("filters a repo with explicit enabled: false", async () => {
    const { handler, sqs } = createTestHandler();
    const body = prBody({ repository: { full_name: "acme/legacy" } });
    const response = await handler(githubEvent(body));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("filters a repo whose ship-it extension is absent (no default-on)", async () => {
    const { handler, sqs } = createTestHandler();
    const body = prBody({ repository: { full_name: "acme/implicit" } });
    const response = await handler(githubEvent(body));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("admits a repo with explicit enabled: true", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(githubEvent(prBody()));
    expect(response.statusCode).toBe(202);
    expect(sqs.sent).toHaveLength(1);
  });

  it("applies the same strict gate on the jira route", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({
      issue: {
        key: "IMP-9",
        fields: {
          project: { key: "IMP" },
          status: { name: "Ready for Implementation" },
          labels: ["ship-it"],
          summary: "Implicit is not opted in",
        },
      },
    });
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });
});

describe("jira admission modes", () => {
  it("admits a labeled ticket with trigger.mode label", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(jiraEvent(jiraIssueBody(), { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(202);
    const payload = sentEnvelope(sqs)["payload"] as Record<string, unknown>;
    expect(payload["trigger"]).toEqual({ source: "jira", mode: "label" });
    expect(payload["labels"]).toEqual(["ship-it"]);
  });

  it("admits an unlabeled comment-created with an @ship-it mention as trigger.mode mention", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({
      webhookEvent: "comment_created",
      comment: { body: "hey @ship-it please pick this up", author: { accountId: "999:zz" } },
    });
    setIssueLabels(body, []);
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(202);
    const envelope = sentEnvelope(sqs);
    const payload = envelope["payload"] as Record<string, unknown>;
    expect(payload["trigger"]).toEqual({ source: "jira", mode: "mention" });
    expect(envelope["endUser"]).toBe("jira:999:zz");
  });

  it("also matches the @shipit spelling", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({
      webhookEvent: "comment_created",
      comment: { body: "cc @shipit", author: { accountId: "999:zz" } },
    });
    setIssueLabels(body, []);
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(202);
    expect(sqs.sent).toHaveLength(1);
  });

  it("filters when neither label nor mention admits", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({
      webhookEvent: "comment_created",
      comment: { body: "unrelated chatter", author: { accountId: "999:zz" } },
    });
    setIssueLabels(body, ["other-label"]);
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("does not honor mentions outside comment-created events", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({
      comment: { body: "@ship-it now", author: { accountId: "999:zz" } },
    });
    setIssueLabels(body, []);
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });
});

describe("jira gates and mapping", () => {
  it("filters an unmapped jira project", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({
      issue: {
        key: "ZZZ-1",
        fields: {
          project: { key: "ZZZ" },
          status: { name: "Ready for Implementation" },
          labels: ["ship-it"],
          summary: "Unmapped project",
        },
      },
    });
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("filters unsupported jira events", async () => {
    const { handler, sqs } = createTestHandler();
    const body = jiraIssueBody({ webhookEvent: "jira:worklog_updated" });
    const response = await handler(jiraEvent(body, { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("maps ticket fields and acceptance criteria into the request", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(jiraEvent(jiraIssueBody(), { secret: JIRA_SECRET }));
    expect(response.statusCode).toBe(202);
    const envelope = sentEnvelope(sqs);
    const payload = envelope["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      ticketKey: "ABC-123",
      projectId: "acme/widgets",
      ticketStatus: "Ready for Implementation",
      ticketSummary: "Implement the widget",
      ticketDescription: "Make it spin",
      acceptanceCriteria: ["AC-1", "AC-2"],
    });
    expect(envelope["endUser"]).toBe("jira:557058:abc");
  });
});

describe("github gates", () => {
  it("filters a draft synchronize (prevents premature review-it)", async () => {
    const { handler, sqs } = createTestHandler();
    const body = prBody({
      action: "synchronize",
      pull_request: {
        number: 7,
        title: "ABC-123: implement the widget",
        draft: true,
        head: { ref: "ship-it/ABC-123" },
      },
    });
    const response = await handler(githubEvent(body));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("filters actions other than ready_for_review/synchronize", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(githubEvent(prBody({ action: "opened" })));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("filters a head branch that does not parse as ship-it/<ticketKey>", async () => {
    const { handler, sqs } = createTestHandler();
    const body = prBody({
      pull_request: {
        number: 7,
        title: "Human-made PR",
        draft: false,
        head: { ref: "feature/just-a-branch" },
      },
    });
    const response = await handler(githubEvent(body));
    expect(response.statusCode).toBe(204);
    expect(sqs.sent).toHaveLength(0);
  });

  it("emits the synthetic PR Ready for Review status with empty labels and prNumber", async () => {
    const { handler, sqs } = createTestHandler();
    const response = await handler(githubEvent(prBody({ action: "synchronize" })));
    expect(response.statusCode).toBe(202);
    const envelope = sentEnvelope(sqs);
    const payload = envelope["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      ticketKey: "ABC-123",
      projectId: "acme/widgets",
      ticketStatus: PR_READY_FOR_REVIEW_STATUS,
      labels: [],
      ticketSummary: "ABC-123: implement the widget",
      prNumber: 7,
      trigger: { source: "github", mode: "pull-request" },
    });
    expect(envelope["endUser"]).toBe("github:octocat");
  });
});

describe("round-trip with the runtime verifier", () => {
  const registry = new MemoryConsumerRegistry([
    {
      consumerId: "webhook-normalizer",
      signingKey: { kind: "literal", base64: SIGNING_KEY_BASE64 },
      allowedKinds: ["ship-it-event"],
    },
  ]);

  it("produces a github envelope verifyEnvelope accepts and parseShipItRequest re-validates", async () => {
    const { handler, sqs } = createTestHandler();
    await handler(githubEvent(prBody(), { deliveryId: "gh-delivery-1" }));
    const envelope = sentEnvelope(sqs);

    const verified = await verifyEnvelope({ envelope, consumerRegistry: registry });
    expect(verified.kind).toBe("ship-it-event");
    expect(verified.consumer).toBe("webhook-normalizer");
    expect(verified.requestId).toBe("gh-delivery-1");
    expect(verified.endUser).toBe("github:octocat");

    const request = parseShipItRequest(verified.payload);
    expect(request.trigger).toEqual({ source: "github", mode: "pull-request" });
    expect(request.ticketKey).toBe("ABC-123");
    expect(request.ticketStatus).toBe(PR_READY_FOR_REVIEW_STATUS);
  });

  it("produces a jira envelope that survives the same round-trip with the trigger intact", async () => {
    const { handler, sqs } = createTestHandler();
    await handler(jiraEvent(jiraIssueBody({ id: "jira-evt-9" }), { secret: JIRA_SECRET }));
    const envelope = sentEnvelope(sqs);

    const verified = await verifyEnvelope({ envelope, consumerRegistry: registry });
    expect(verified.requestId).toBe("jira-evt-9");

    const request = parseShipItRequest(verified.payload);
    expect(request.trigger).toEqual({ source: "jira", mode: "label" });
    expect(request.acceptanceCriteria).toEqual(["AC-1", "AC-2"]);
  });

  it("rejects the envelope when the registry holds a different key", async () => {
    const { handler, sqs } = createTestHandler();
    await handler(githubEvent(prBody()));
    const envelope = sentEnvelope(sqs);
    const wrongKeyRegistry = new MemoryConsumerRegistry([
      {
        consumerId: "webhook-normalizer",
        signingKey: { kind: "literal", base64: Buffer.from("other-key").toString("base64") },
        allowedKinds: ["ship-it-event"],
      },
    ]);
    await expect(
      verifyEnvelope({ envelope, consumerRegistry: wrongKeyRegistry }),
    ).rejects.toThrowError(/signature/);
  });
});

describe("dedupe", () => {
  it("suppresses a second identical delivery and sends exactly once", async () => {
    const { handler, sqs } = createTestHandler();
    const event = githubEvent(prBody(), { deliveryId: "dup-1" });

    const first = await handler(event);
    expect(first.statusCode).toBe(202);

    const second = await handler(event);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body!)).toEqual({ deduped: true });
    expect(sqs.sent).toHaveLength(1);
  });

  it("dedupes jira deliveries on the body event id", async () => {
    const { handler, sqs } = createTestHandler();
    const event = jiraEvent(jiraIssueBody({ id: "evt-42" }), { secret: JIRA_SECRET });

    expect((await handler(event)).statusCode).toBe(202);
    expect((await handler(event)).statusCode).toBe(200);
    expect(sqs.sent).toHaveLength(1);
  });
});

describe("malformed input", () => {
  it("answers 400 for a signed but non-JSON body", async () => {
    const { handler, sqs } = createTestHandler();
    const raw = Buffer.from("not json", "utf8");
    const response = await handler({
      rawPath: "/github",
      headers: {
        "x-hub-signature-256": githubSignature(raw),
        "x-github-delivery": randomUUID(),
      },
      body: raw.toString("utf8"),
      isBase64Encoded: false,
    });
    expect(response.statusCode).toBe(400);
    expect(sqs.sent).toHaveLength(0);
  });

  it("answers 500 when the sender throws", async () => {
    const { handler } = createTestHandler({
      sender: {
        async send() {
          throw new Error("sqs unavailable");
        },
      },
    });
    const response = await handler(githubEvent(prBody()));
    expect(response.statusCode).toBe(500);
  });

  it("a failed send releases the dedupe claim — the provider's retry is sent, not suppressed", async () => {
    // Regression for the claim-before-send bug: marking the delivery as
    // processed before the send succeeds would swallow the retry.
    const dedupe = new InMemoryTtlDedupeStore();
    const sqs = new CapturingSqsClient();
    const real = new SqsEnvelopeSender({ queueUrl: QUEUE_URL, client: sqs });
    let failures = 1;
    const flaky = {
      async send(envelope: Parameters<SqsEnvelopeSender["send"]>[0]) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("sqs unavailable");
        }
        return real.send(envelope);
      },
    };
    const { handler } = createTestHandler({ dedupe, sender: flaky });
    // Provider redeliveries reuse the SAME delivery id — pin it.
    const deliveryId = "delivery-retry-1";

    const first = await handler(githubEvent(prBody(), { deliveryId }));
    expect(first.statusCode).toBe(500);
    expect(sqs.sent).toHaveLength(0);

    // The provider's retry of the same delivery — must be admitted and sent.
    const retry = await handler(githubEvent(prBody(), { deliveryId }));
    expect(retry.statusCode).toBe(202);
    expect(sqs.sent).toHaveLength(1);

    // And a THIRD identical delivery after success is the real duplicate.
    const third = await handler(githubEvent(prBody(), { deliveryId }));
    expect(third.statusCode).toBe(200);
    expect(JSON.parse(third.body ?? "{}")).toMatchObject({ deduped: true });
    expect(sqs.sent).toHaveLength(1);
  });
});

/** Mutate the fixture's nested labels array (test convenience). */
function setIssueLabels(body: Record<string, unknown>, labels: ReadonlyArray<string>): void {
  const issue = body["issue"] as { fields: Record<string, unknown> };
  issue.fields = { ...issue.fields, labels: [...labels] };
}
