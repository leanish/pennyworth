# agent-infra

AWS CDK (TypeScript) infrastructure for the leanish agent suite. Reads each Layer-3 agent's
descriptor (`agent.yaml`, via `@leanish/runtime`'s `loadDescriptorFromFile`) plus the
runtime's needs registry, and provisions the AWS resources they imply. Application repos carry
**zero** IaC (suite-0006).

The contract this implements — the resources + IAM grants each descriptor field and declared
`need` produces — is part of the suite's design docs, maintained separately; the
registry⇄descriptor consistency tests under `test/` enforce the implemented half.

## Layout

```
bin/agent-infra.ts       # CDK app: SharedStack + one AgentStack per registered agent + the normalizer
src/registry.ts          # the deploy roster (agents + the ship-it webhook normalizer)
src/shared-stack.ts      # catalog S3 bucket, EventBridge bus, secrets CMK
src/agent-stack.ts       # per-agent: tables, queues, Lambda, IAM, event source, scheduler wiring
src/normalizer-stack.ts  # ship-it webhook gate: Function URL Lambda → ship-it's input queue
src/needs-policy.ts      # declared need → IAM statements (reads the needs registry)
```

Scheduler-trigger agents (bump-it, document-it) get a recurring EventBridge Scheduler
tick (`tickSchedule` in `src/registry.ts`); multi-stage agents additionally get the
self-publish wiring (`SELF_QUEUE_URL`/`SCHEDULE_GROUP_NAME`/… env, per-agent schedule
group, the Scheduler delivery role). The ship-it normalizer's webhook secrets and Jira
project map are deploy-operator inputs, read at synth from
`SHIP_IT_NORMALIZER_<NAME>` env vars (see `src/normalizer-stack.ts`).

## Usage

```bash
npm install
npm run check        # typecheck + build + test (registry/descriptor consistency + synth assertions)
npx cdk synth        # render CloudFormation (no AWS creds needed)
npx cdk diff         # against a deployed account
npx cdk deploy       # account+region from CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION
```

Deploy a new agent: build/push its image to ECR, add a row to `src/registry.ts`, `cdk deploy`.

## Status / prerequisites

The app synthesizes cleanly (`npm run synth`) and the templates are covered by
`test/stacks.test.ts`. Two suite-level prerequisites gate a real deploy:

1. **Base image needs `git`** — added to `agent-runtime/Dockerfile.base`; verify via
   `ask-the-code`'s `npm run lambda:rehearsal`.
2. **Packages must be publishable** — `@leanish/runtime` / `@leanish/ask-the-code` are still
   `private` / `file:`-linked; `agent-infra` consumes the descriptor locally via `file:` today,
   and pins versions once they publish under the `@leanish` npm scope.
