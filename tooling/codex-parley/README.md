# parley

`parley` is a local CLI harness that runs Codex and Claude Code in a bounded relay. One coding
agent reviews, the other responds or acts, and the run exits when both agree, deadlocks, escalates
to the human, or fails.

## Usage

```bash
parley "review this local change"
parley "review this local change" "apply the agreed fixes"
parley --first claude --rounds 3 "review this local change"
```

Useful outputs:

```bash
parley --output result.json --steps-output steps.json "review this local change"
```

`stdout` is human-readable. `--output` is the stable machine-readable result document.

## Development

```bash
npm install
npm run check
```

The tests use fake runners and do not invoke real `codex` or `claude` binaries.

The optional real-CLI acceptance check exercises the phase-1 contract that a coding agent can edit
files and return schema-conforming structured output in one invocation:

```bash
npm run test:acceptance
```

It invokes the installed `codex` and `claude` CLIs and therefore depends on local auth, credits, and
non-interactive CLI configuration.
