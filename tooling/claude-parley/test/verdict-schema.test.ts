import { describe, expect, it } from "vitest";

import { parseVerdict, VERDICT_SCHEMA_JSON } from "../src/index.js";
import { extractVerdictFromText } from "../src/agents/verdict-schema.js";

describe("parseVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const v = parseVerdict({ status: "done", summary: "ok", reason: "looks good", body: "..." });
    expect(v.status).toBe("done");
    expect(v.summary).toBe("ok");
  });

  it("rejects an unknown status", () => {
    expect(() => parseVerdict({ status: "agree", summary: "", reason: "", body: "" })).toThrow(/status/);
  });

  it("rejects a missing string field", () => {
    expect(() => parseVerdict({ status: "done", summary: "ok", reason: "ok" })).toThrow(/body/);
  });

  it("rejects non-objects", () => {
    expect(() => parseVerdict("nope")).toThrow();
    expect(() => parseVerdict(null)).toThrow();
  });

  it("exposes a parseable schema string", () => {
    expect(() => JSON.parse(VERDICT_SCHEMA_JSON)).not.toThrow();
  });
});

describe("extractVerdictFromText (prose fallback)", () => {
  it("recovers a verdict from a fenced ```json block", () => {
    const text = [
      "I created the file as agreed.",
      "```json",
      '{"status":"done","summary":"applied","reason":"applied the plan","body":"created GREETING.txt"}',
      "```",
    ].join("\n");
    const v = extractVerdictFromText(text);
    expect(v.status).toBe("done");
    expect(v.summary).toBe("applied");
  });

  it("recovers a trailing bare JSON object when there is no fence", () => {
    const text =
      'Report: applied.\n{"status":"continue","summary":"objection","reason":"plan is unsafe","body":"..."}';
    expect(extractVerdictFromText(text).status).toBe("continue");
  });

  it("returns the last valid verdict when several JSON blocks appear", () => {
    const text = [
      '```json\n{"status":"continue","summary":"draft","reason":"x","body":"y"}\n```',
      '```json\n{"status":"done","summary":"final","reason":"x","body":"y"}\n```',
    ].join("\n\n");
    expect(extractVerdictFromText(text).summary).toBe("final");
  });

  it("throws when no JSON verdict is present", () => {
    expect(() => extractVerdictFromText("just prose, no json here")).toThrow(/no parseable JSON verdict/);
  });
});
