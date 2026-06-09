---
name: consult-codex
description: Run a bounded, alternating deliberation between the live Claude Code session and Codex (a read-only second coding agent run as a CLI subprocess). You drive and implement; Codex reviews, validates, expands, and suggests; you converge and write the answer. Use when you want a second coding agent to vet or sharpen your analysis or changes — code/PR review, design or library choices, "sanity-check this", "what am I missing", or "review the PR and handle what we agree on". Requires the `codex` CLI on PATH.
---

# consult-codex

A second coding agent (**Codex**) reviews and sharpens **your** work in a bounded back-and-forth —
without you ever spawning another `claude -p`. **You** (this live session) are the driver: you
analyse, implement (only in action mode), resolve any human questions, and write the final answer.
**Codex** is read-only — it never edits files — but a full collaborator: it reviews, validates,
expands on findings, suggests ideas, and flags risks.

The bundled helper `bin/consult-codex-step.mjs` owns all bookkeeping — running Codex, counting
rounds (budget: **5**), threading the Codex session, deciding termination, and the state file. You
only do your own turn and report a verdict; the helper decides everything else.

## Hard rules

- **Never** spawn `claude -p`. You perform every one of your own turns natively (full tools, the real
  working tree, this conversation). Codex is the only subprocess.
- Codex reviews **read-only**; only you edit the working tree, and only in action mode.
- Don't reimplement rounds/termination in prose — that's the helper's job.

## Run it

`/consult-codex <plain-English request>` — e.g. *"do a full review of the PR and handle the findings
you agree with"*, or *"which serialization library should we use here?"*.

**Step 0 — locate the helper.** It lives next to this `SKILL.md`. Set `HELPER` to the absolute path
of `bin/consult-codex-step.mjs` inside this skill's directory (the base directory you were given when
this skill loaded), and use it for every call below.

**Step 1 — derive two things from the request:**
- **task** — the subject to deliberate (what Codex reviews first). Always present.
- **action** — the work to apply, *only if the user is asking for changes to be made*. A pure
  question / review / assessment yields **no action** ⇒ the whole run stays read-only.

## The loop

```
out = node "$HELPER" --task "<task>" [--action "<action>"]
while true:
  case out.phase:
    "session-turn":
        # Codex's turn is in out.codex {status, summary, reason, body}. Now do YOUR turn natively:
        #   - analyse the task in light of out.codex.body
        #   - in action mode, edit the working tree on the parts you both agree on
        #   - if out.codex.status == "needs-user" OR a real human decision is required:
        #       ASK the user now, fold in the answer, then continue
        out = node "$HELPER" --run <out.runId> --verdict '{"status":"continue|done","summary":"…","body":"…"}'
        # done  = nothing material remains from your side
        # continue = there is more to add or do (the helper then runs one more Codex review)
    "settled":   # converged. Write the FINALIZER (read-only): the consolidated answer, or — in action
                 # mode — what changed, what you deliberately left, and any caveats. Use
                 # out.closing.verdict plus your own turn context. Then STOP.
    "exhausted": # 5 rounds with no "done". Report where things stand from out.lastCodexVerdict and
                 # out.lastSessionVerdict. STOP.
    "failed":    # a Codex invocation failed. Report out.error and the run id (the state file is kept
                 # for inspection / resume). STOP.
```

Report `done` the moment nothing material is left from your side. The **opening** Codex turn never
ends the run — you always respond to it (a `done` or `needs-user` from the opener is just context).

## Resume

A run survives this session ending mid-flight (state is stored outside the repo, keyed by run id):

```
node "$HELPER" --resume <run-id>
```

returns the pending phase; rejoin the loop from there. Run it from the directory the run started in
(the helper warns if you don't).

## Reference

Verdict types, the exact Codex prompts, the state-file shape, and error handling are in
[PROTOCOL.md](PROTOCOL.md). The helper is dependency-free Node ESM (Node ≥ 18) and needs the `codex`
CLI on PATH. This skill is Claude Code-specific by design (the live session is one of the two agents).
