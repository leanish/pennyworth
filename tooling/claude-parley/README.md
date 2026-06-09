# claude-parley

`parley` is a local CLI harness that runs two coding agents — Codex (`codex`) and Claude Code
(`claude`) — against the same task in a bounded, alternating **relay**, and escalates to you only
when they cannot converge. It is a developer tool, not a deployable agent: it shells out to the
local CLIs non-interactively, never calls a model API directly, and never edits source files itself.

## Install

```bash
npm install
npm run check      # typecheck + build + tests (mock runners; no real CLIs needed)
```

Requires Node ≥ 24 and the `codex` / `claude` CLIs on PATH for real runs.

## Usage

```bash
# Read-only deliberation (no second prompt → nobody edits files):
parley "which lib (if any) should we use for serialization?"

# Action: deliberate, then act on the agreed parts:
parley "review the PR for correctness risks" "handle the findings"
```

**agent-1** (default Codex) opens and stays read-only; **agent-2** (default Claude Code) responds,
acts on the agreed parts when a second prompt is given, and runs the closing finalizer. `--first
claude` swaps which CLI fills which slot.

### Options

| Option | Default | Meaning |
|---|---|---|
| `--rounds <n>` | `5` | Max rounds; one round = agent-1 turn + agent-2 turn. |
| `--first <codex\|claude>` | `codex` | Which CLI is agent-1 (the read-only opener). |
| `--claude-session <id>` | — | Resume Claude's side (both-or-neither with `--codex-session`). |
| `--codex-session <id>` | — | Resume Codex's side (both-or-neither with `--claude-session`). |
| `--output <path>` | — | Write the stable JSON result document. |
| `--steps-output <path>` | — | Write the per-turn steps array. |
| `--verbose` | off | Diagnostics to stderr. |

### Outcomes & exit codes

- `0` **settled** — a responding turn returned `done`; the finalizer ran (its body is the result).
- `2` **exhausted** — rounds ran out with no `done` (budget exhausted, not necessarily disagreement).
- `3` **needs-user** — a turn returned `needs-user`; a human decision is required.
- `4` **failed** — a coding-agent invocation failed unrecoverably.
- `1` — usage error (bad args, or mixed resume).

On `exhausted` / `needs-user`, stdout ends with a ready-to-run **continuation command** (both
session ids pre-filled) so you can resume the same deliberation with new guidance.

## Execution flow

The relay alternates agent‑1 (opener, read‑only) and agent‑2 (responder/actor), checking each
turn's verdict. The **opening turn can only continue or fail** — a `done` or `needs-user` there is
deferred to agent‑2 (which may resolve it), so only an `error` stops on the opener. The relay
settles as soon as a *responding* turn returns `done`, then a finalizer turn produces the
deliverable.

```mermaid
flowchart TD
    Start(["parley: prompt-1, optional prompt-2"]) --> A1["agent-1 turn<br/>read-only"]
    A1 --> A1C{verdict}
    A1C -->|error| FAIL["exit 4: failed"]
    A1C -->|"needs-user — later turn only"| ESC["exit 3: needs-user"]
    A1C -->|"done — later turn only"| FIN["finalizer<br/>agent-2, read-only"]
    A1C -->|"continue, or ANY opening-turn verdict"| A2["agent-2 turn<br/>acts if prompt-2"]
    A2 --> A2C{verdict}
    A2C -->|needs-user| ESC
    A2C -->|error| FAIL
    A2C -->|done| FIN
    A2C -->|continue| R{rounds left?}
    R -->|yes| A1
    R -->|no| EXH["exit 2: exhausted"]
    FIN --> SET(["exit 0: settled<br/>result = finalizer body"])
    ESC --> CC["print continuation command"]
    EXH --> CC
```

### Read-only walkthrough — `parley "which lib for serialization?"`

Both slots only deliberate; the finalizer consolidates the converged answer. Nothing is edited.

```mermaid
sequenceDiagram
    actor U as You
    participant P as parley
    participant A1 as agent-1
    participant A2 as agent-2
    U->>P: parley "which lib for serialization?"
    P->>A1: prompt-1, read-only
    A1-->>P: continue — recommend X, because…
    P->>A2: prompt-1 + "sibling says…", agree/expand/correct
    A2-->>P: done — agree, with one caveat
    P->>A2: finalizer — consolidate the result
    A2-->>P: done — consolidated answer
    P-->>U: exit 0 settled, + result
```

### Action walkthrough — `parley "review the PR" "handle the findings"`

agent‑1 reviews read‑only; agent‑2 acts on the agreed parts each turn; the finalizer reports what
changed, what didn't, and any caveats.

```mermaid
sequenceDiagram
    actor U as You
    participant P as parley
    participant A1 as agent-1
    participant A2 as agent-2
    U->>P: parley "review the PR" "handle the findings"
    P->>A1: check prompt-1, tell me how you'd deal with it
    A1-->>P: continue — the findings
    P->>A2: prompt-1 + findings + "handle them on the agreed parts"
    Note over A2: edits the working tree
    A2-->>P: continue — applied some, more to do
    P->>A1: sibling says…, review the changes read-only
    A1-->>P: done — changes look correct
    P->>A2: finalizer — report changed/not-changed/caveats
    A2-->>P: done — change report
    P-->>U: exit 0 settled, + report
```

## How it works

- A **round** is one agent-1 turn then one agent-2 turn. Each turn returns a structured verdict
  whose `status` is `continue` (something material remains) or `done` (nothing material remains).
- The relay **settles** as soon as the *responding* turn returns `done` (the opener can't settle),
  then runs a read-only **finalizer** on agent-2 — consolidating the answer (read-only flow) or
  reporting what changed / didn't / caveats (action flow).
- The verdict is enforced by each CLI's native structured output (`codex exec --output-schema`,
  `claude --json-schema`). Claude drops structured output on any `--resume` turn that uses tools, so
  the Claude runner also asks for a fenced ```json verdict block and parses that as a fallback.

### Phase 1 caveats

- parley injects **no** permission/sandbox flags; it inherits your `codex` / `claude` CLI config,
  which must permit non-interactive runs and let agent-2 edit. agent-1's read-only behavior is
  prompt-advisory in phase 1; structural enforcement is phase 2.
- Resume is **both-or-neither** (a fresh run, or a continuation of both sessions).
- The acceptance gate — an agent editing files **and** returning a conforming verdict in one
  invocation — is covered by a skipped integration test (`test/acceptance.integration.test.ts`).
