import { describe, expect, it } from "vitest";

import { needPolicyStatements } from "../src/needs-policy.js";
import {
  NO_TARGET_CREDENTIALS_CONFIG,
  parseTargetCredentialsContext,
  type TargetCredentialsInfraConfig,
} from "../src/target-credentials-config.js";

const BASE_CTX = {
  need: "target-credentials",
  agentId: "bump-it",
  region: "us-east-1",
  account: "111111111111",
  eventBusArn: "arn:aws:events:us-east-1:111111111111:event-bus/leanish",
};

const CONFIG: TargetCredentialsInfraConfig = {
  codeartifactDomainArns: ["arn:aws:codeartifact:us-east-1:222222222222:domain/acme"],
  codeartifactRepositoryArns: [
    "arn:aws:codeartifact:us-east-1:222222222222:repository/acme/java",
  ],
};

function statementJsons(ctx: Parameters<typeof needPolicyStatements>[0]): unknown[] {
  return needPolicyStatements(ctx).map((s) => s.toStatementJson());
}

describe("target-credentials need policy", () => {
  it("grants SSM-only with the empty default config", () => {
    const statements = statementJsons(BASE_CTX);
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: "arn:aws:ssm:us-east-1:111111111111:parameter/leanish/projects/*/credentials/*",
      },
    ]);
  });

  it("adds scoped CodeArtifact statements when domains/repos are configured", () => {
    const statements = statementJsons({ ...BASE_CTX, targetCredentials: CONFIG });
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: "codeartifact:GetAuthorizationToken",
      Resource: "arn:aws:codeartifact:us-east-1:222222222222:domain/acme",
    });
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: "sts:GetServiceBearerToken",
      Resource: "*",
      Condition: { StringEquals: { "sts:AWSServiceName": "codeartifact.amazonaws.com" } },
    });
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: ["codeartifact:GetRepositoryEndpoint", "codeartifact:ReadFromRepository"],
      Resource: "arn:aws:codeartifact:us-east-1:222222222222:repository/acme/java",
    });
    // Read-only by construction: no publish actions, ever.
    expect(JSON.stringify(statements)).not.toContain("PublishPackageVersion");
  });
});

describe("parseTargetCredentialsContext", () => {
  it("returns the empty config when context is absent", () => {
    expect(parseTargetCredentialsContext(undefined)).toEqual(NO_TARGET_CREDENTIALS_CONFIG);
  });

  it("accepts the object form and the --context JSON-string form", () => {
    expect(parseTargetCredentialsContext(CONFIG)).toEqual(CONFIG);
    expect(parseTargetCredentialsContext(JSON.stringify(CONFIG))).toEqual(CONFIG);
  });

  it("rejects unknown keys, non-ARN entries, and malformed JSON", () => {
    expect(() => parseTargetCredentialsContext({ domains: [] })).toThrow(/unknown key 'domains'/);
    expect(() =>
      parseTargetCredentialsContext({ codeartifactDomainArns: ["not-an-arn"] }),
    ).toThrow(/array of ARNs/);
    expect(() => parseTargetCredentialsContext("{nope")).toThrow(/not valid JSON/);
  });
});
