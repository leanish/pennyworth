# agent-infra

AWS CDK (TypeScript) infrastructure for the leanish agent suite. Reads each Layer-3 agent's
descriptor (`agent.yaml`, via `@leanish/runtime`'s `loadDescriptorFromFile`) plus the
runtime's needs registry, and provisions the AWS resources they imply. Application repos carry
**zero** IaC (suite-0006).

The contract this implements — the resources + IAM grants each descriptor field and declared
`need` produces — is specified at `contract.md`.

## Layout

```
bin/agent-infra.ts     # CDK app: SharedStack + one AgentStack per registered agent
src/registry.ts        # the deploy roster (which agents + their ECR image)
src/shared-stack.ts    # catalog S3 bucket, EventBridge bus, secrets CMK
src/agent-stack.ts     # per-agent: tables, queues, Lambda, IAM, event source
src/needs-policy.ts    # declared need → IAM statements (reads the needs registry)
```

## Usage

```bash
npm install
npm run check        # typecheck + build + test (the CDK-free registry test)
npx cdk synth        # render CloudFormation (no AWS creds needed)
npx cdk diff         # against a deployed account
npx cdk deploy       # account+region from CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION
```

Deploy a new agent: build/push its image to ECR, add a row to `src/registry.ts`, `cdk deploy`.

## Status / prerequisites

This is the first scaffold — **not yet `cdk synth`-validated here** (it's written against
`aws-cdk-lib` v2; run `npm install && npx cdk synth` to confirm). Two suite-level prerequisites
gate a real deploy (see the contract §9):

1. **Base image needs `git`** — added to `agent-runtime/Dockerfile.base`; verify via
   `ask-the-code`'s `npm run lambda:rehearsal`.
2. **Packages must be publishable** — `@leanish/runtime` / `@leanish/ask-the-code` are still
   `private` / `file:`-linked; `agent-infra` consumes the descriptor locally via `file:` today,
   and pins versions once they publish under the `@leanish` npm scope.
