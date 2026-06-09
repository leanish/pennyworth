import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTurnOutcome } from "./codex-converse.mjs";

const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

test("captures thread id, usage, and the final agent message from a successful turn", () => {
  const stdout = lines(
    { type: "thread.started", thread_id: "019eABC" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "reasoning", text: "thinking..." } },
    { type: "item.completed", item: { type: "agent_message", text: "the answer" } },
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 5 } }
  );
  const out = parseTurnOutcome(stdout, "");
  assert.equal(out.threadId, "019eABC");
  assert.equal(out.message, "the answer"); // not the reasoning item
  assert.equal(out.usage.input_tokens, 100);
  assert.equal(out.error, "");
});

test("prefers the -o last-message text over the agent_message event", () => {
  const stdout = lines({ type: "item.completed", item: { type: "agent_message", text: "from stream" } });
  assert.equal(parseTurnOutcome(stdout, "  from -o file \n").message, "from -o file");
});

test("falls back to the agent_message event when the -o text is empty", () => {
  const stdout = lines({ type: "item.completed", item: { type: "agent_message", text: "fallback" } });
  assert.equal(parseTurnOutcome(stdout, "   ").message, "fallback");
});

test("surfaces a quota/credit failure from error and turn.failed events", () => {
  const stdout = lines(
    { type: "thread.started", thread_id: "019eX" },
    { type: "turn.started" },
    { type: "error", message: "Your workspace is out of credits." },
    { type: "turn.failed", error: { message: "Your workspace is out of credits." } }
  );
  const out = parseTurnOutcome(stdout, "");
  assert.equal(out.error, "Your workspace is out of credits.");
  assert.equal(out.threadId, "019eX"); // thread still captured even on failure
});

test("takes the first thread id and the last usage/message when several appear", () => {
  const stdout = lines(
    { type: "thread.started", thread_id: "first" },
    { type: "thread.started", thread_id: "second" },
    { type: "item.completed", item: { type: "agent_message", text: "older" } },
    { type: "turn.completed", usage: { input_tokens: 1 } },
    { type: "item.completed", item: { type: "agent_message", text: "newest" } },
    { type: "turn.completed", usage: { input_tokens: 2 } }
  );
  const out = parseTurnOutcome(stdout, "");
  assert.equal(out.threadId, "first");
  assert.equal(out.message, "newest");
  assert.equal(out.usage.input_tokens, 2);
});

test("ignores non-JSON noise lines without throwing", () => {
  const stdout = ["Reading additional input from stdin...", "", JSON.stringify({ type: "thread.started", thread_id: "ok" }), "garbage{"].join("\n");
  assert.equal(parseTurnOutcome(stdout, "done").threadId, "ok");
});
