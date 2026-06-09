import { describe, expect, it } from "vitest";

import { ClaudeRunner, CodexRunner } from "../src/index.js";

/**
 * Phase-1 acceptance gate (specs/relay.md): the actor must be able to edit the working tree AND
 * return a schema-conforming verdict in a single invocation. This requires the real `claude` /
 * `codex` CLIs and a scratch working tree, so it is skipped by default. Run it deliberately
 * (e.g. `RUN_PARLEY_ACCEPTANCE=1 vitest run acceptance`) against a disposable directory; a
 * regression here is a release blocker, not a reason to reintroduce prose parsing.
 */
describe.skip("acceptance: actor edits + schema verdict in one invocation", () => {
  it("claude actor returns a conforming verdict after editing", async () => {
    const runner = new ClaudeRunner();
    const verdict = await runner.run(
      "Create a file named PARLEY_OK.txt containing 'ok' in the current directory, then report.",
    );
    expect(["continue", "done", "needs-user"]).toContain(verdict.status);
  });

  it("codex actor returns a conforming verdict after editing", async () => {
    const runner = new CodexRunner();
    const verdict = await runner.run(
      "Create a file named PARLEY_OK.txt containing 'ok' in the current directory, then report.",
    );
    expect(["continue", "done", "needs-user"]).toContain(verdict.status);
  });
});
