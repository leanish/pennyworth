import { describe, expect, it } from "vitest";

import {
  parseS3Uri,
  parseTriageRequest,
  TriageValidationError,
} from "../src/request-schema.js";

const VALID = {
  ticketKey: "SUP-1234",
  customer: "customer-1",
  evidenceBlobUri: "s3://evidence-bucket/customer-1/SUP-1234.tar.gz",
};

describe("parseTriageRequest", () => {
  it("accepts the minimal valid request", () => {
    const parsed = parseTriageRequest(VALID);
    expect(parsed).toEqual(VALID);
  });

  it("accepts the full request with problem and projectIds", () => {
    const parsed = parseTriageRequest({
      ...VALID,
      problem: "recommendations are empty since Tuesday",
      projectIds: ["leanish/agent-runtime"],
    });
    expect(parsed.problem).toBe("recommendations are empty since Tuesday");
    expect(parsed.projectIds).toEqual(["leanish/agent-runtime"]);
  });

  it("rejects a non-object request", () => {
    expect(() => parseTriageRequest("nope")).toThrow(TriageValidationError);
    expect(() => parseTriageRequest(null)).toThrow(TriageValidationError);
    expect(() => parseTriageRequest([VALID])).toThrow(TriageValidationError);
  });

  it.each(["ticketKey", "customer", "evidenceBlobUri"] as const)(
    "rejects a missing or empty %s",
    (field) => {
      const { [field]: _omitted, ...withoutField } = VALID;
      expect(() => parseTriageRequest(withoutField)).toThrow(new RegExp(field));
      expect(() => parseTriageRequest({ ...VALID, [field]: "" })).toThrow(new RegExp(field));
      expect(() => parseTriageRequest({ ...VALID, [field]: 42 })).toThrow(new RegExp(field));
    },
  );

  it("rejects a non-s3 evidenceBlobUri", () => {
    expect(() =>
      parseTriageRequest({ ...VALID, evidenceBlobUri: "https://example.com/x.tar.gz" }),
    ).toThrow(/s3:\/\//);
  });

  it("rejects an s3 URI without a key portion", () => {
    expect(() =>
      parseTriageRequest({ ...VALID, evidenceBlobUri: "s3://bucket-only" }),
    ).toThrow(TriageValidationError);
    expect(() =>
      parseTriageRequest({ ...VALID, evidenceBlobUri: "s3://bucket-only/" }),
    ).toThrow(TriageValidationError);
  });

  it("rejects a non-string problem", () => {
    expect(() => parseTriageRequest({ ...VALID, problem: 42 })).toThrow(/problem/);
  });

  it("rejects projectIds that are not an array of non-empty strings", () => {
    expect(() => parseTriageRequest({ ...VALID, projectIds: "leanish/x" })).toThrow(
      /projectIds/,
    );
    expect(() => parseTriageRequest({ ...VALID, projectIds: [42] })).toThrow(/projectIds/);
    expect(() => parseTriageRequest({ ...VALID, projectIds: [""] })).toThrow(/projectIds/);
  });
});

describe("parseS3Uri", () => {
  it("splits bucket and key", () => {
    expect(parseS3Uri("s3://my-bucket/some/deep/key.tar.gz")).toEqual({
      bucket: "my-bucket",
      key: "some/deep/key.tar.gz",
    });
  });

  it("rejects malformed URIs", () => {
    expect(() => parseS3Uri("s3://")).toThrow(TriageValidationError);
    expect(() => parseS3Uri("s3:///key-no-bucket")).toThrow(TriageValidationError);
    expect(() => parseS3Uri("file:///tmp/x.tar.gz")).toThrow(TriageValidationError);
  });
});
