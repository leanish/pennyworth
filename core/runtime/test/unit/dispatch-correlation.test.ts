import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { defineAgent } from "../../src/define-agent.js";
import { dispatch } from "../../src/dispatch/dispatch.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";
import type { Runtime } from "../../src/types/runtime.js";
import type { RuntimeMessage } from "../../src/types/runtime-message.js";

const DESCRIPTOR: AgentDescriptor = {
  identifier: "atc",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: false }],
  stages: ["init"],
  codingAgent: "claude-code",
  model: "m",
  skills: { entrypoints: ["ask"], support: [] },
  needs: [],
  extensions: {},
};

describe("dispatch propagates correlation context", () => {
  it("emits log lines that carry requestId / sourceTrigger / stage from the handler", async () => {
    const stream = new PassThrough();
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    const logger = new ConsoleLogger({ stream, minLevel: "debug" });

    const runtime = { logger } as unknown as Runtime;

    const agent = defineAgent({
      identifier: "atc",
      async handle(_message, rt) {
        rt.logger.info("inside handler");
      },
    });

    const message: RuntimeMessage = {
      stage: "init",
      payload: {},
      metadata: {
        receivedAt: "2026-05-23T00:00:00.000Z",
        sourceTrigger: "consumer",
        requestId: "msg-correlation-1",
      },
    };

    await dispatch(agent, DESCRIPTOR, runtime, message);

    expect(buf).toContain('"msg":"inside handler"');
    expect(buf).toContain('"requestId":"msg-correlation-1"');
    expect(buf).toContain('"sourceTrigger":"consumer"');
    expect(buf).toContain('"stage":"init"');
  });

  it("does not leak correlation to log lines emitted outside the dispatch run", async () => {
    const stream = new PassThrough();
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    const logger = new ConsoleLogger({ stream, minLevel: "debug" });

    const runtime = { logger } as unknown as Runtime;

    const agent = defineAgent({
      identifier: "atc",
      async handle() {
        /* no-op */
      },
    });

    const message: RuntimeMessage = {
      stage: "init",
      payload: {},
      metadata: {
        receivedAt: "2026-05-23T00:00:00.000Z",
        sourceTrigger: "consumer",
        requestId: "msg-correlation-2",
      },
    };

    await dispatch(agent, DESCRIPTOR, runtime, message);
    logger.info("outside dispatch");

    expect(buf).toContain('"msg":"outside dispatch"');
    // The "outside dispatch" line should NOT carry the dispatch correlation.
    const lines = buf.split("\n").filter((l) => l.length > 0);
    const outsideLine = lines.find((l) => l.includes("outside dispatch"))!;
    expect(outsideLine).not.toContain("msg-correlation-2");
  });
});
