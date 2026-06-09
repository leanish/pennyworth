#!/usr/bin/env node
// consult-codex-step — the re-entrant state machine that drives a consult-codex run.
//
// The live Claude Code session calls this between its own native turns. The helper owns ALL
// bookkeeping: running the Codex turns, counting rounds, threading the Codex session, deciding
// termination, and persisting state. Each invocation: load state -> do the one deterministic action
// for the current state -> persist -> print exactly one StepResult JSON object to stdout.
//
// Invocations:
//   consult-codex-step --task "<task>" [--action "<action>"]            # start; runs the Codex opener
//   consult-codex-step --run <run-id> --verdict '<SessionVerdict JSON>' # report the session's turn
//   consult-codex-step --resume <run-id>                                # re-fetch the pending phase
//
// Dependency-free Node ESM. Requires the `codex` CLI on PATH and Node >= 18.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_ROUNDS = 5;

// The reviewer (Codex) verdict schema — enforced via `codex exec --output-schema`.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'reason', 'body'],
  properties: {
    status: { type: 'string', enum: ['continue', 'done', 'needs-user', 'error'] },
    summary: { type: 'string' },
    reason: { type: 'string' },
    body: { type: 'string' },
  },
};

const CODEX_STATUSES = new Set(['continue', 'done', 'needs-user', 'error']);
const SESSION_STATUSES = new Set(['continue', 'done']);

// ---------------------------------------------------------------------------
// Codex prompts — the wording IS the protocol.
// ---------------------------------------------------------------------------

function openerPrompt(task) {
  return `You are the read-only second agent in a two-agent deliberation. You may not edit files — but beyond reviewing, feel free to validate the approach, expand on it, surface considerations, suggest concrete ideas, and flag risks.

Task:
${task}

Give your assessment and state your position. Set \`status\` = \`done\` if there is nothing material to add, \`continue\` if there is more to add or address (be concrete in \`body\`), or \`needs-user\` if a genuinely human decision is required.`;
}

function reviewPrompt(task, action, sessionBody) {
  const taskBlock = action ? `${task}\nRequested action: ${action}` : task;
  return `You are the read-only second agent — you may not edit files. Review and validate the work, and suggest improvements or ideas where useful.

Task:
${taskBlock}

Your sibling agent (the Claude Code session) just did:
${sessionBody}

Inspect the current working tree read-only and judge whether it now satisfies the task. Set \`status\` = \`done\` if nothing material remains, \`continue\` if there is more to add or address (be concrete in \`body\`), or \`needs-user\` if a genuinely human decision is required.`;
}

// ---------------------------------------------------------------------------
// State file — kept OUTSIDE the working tree, 0700 dir / 0600 files.
// ---------------------------------------------------------------------------

function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'consult-codex');
}

function stateFilePath(runId) {
  return path.join(stateDir(), `${runId}.json`);
}

function saveState(state) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const file = stateFilePath(state.runId);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function loadState(runId) {
  const file = stateFilePath(runId);
  if (!fs.existsSync(file)) usageError(`no run found for id "${runId}" (expected ${file})`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    usageError(`run state for "${runId}" is unreadable: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// The Codex turn (self-contained ~30 lines).
// ---------------------------------------------------------------------------

function runCodex({ prompt, resumeThread }) {
  const tmp = os.tmpdir();
  const schemaFile = path.join(tmp, `ccx-schema-${randomUUID()}.json`);
  const lastFile = path.join(tmp, `ccx-last-${randomUUID()}.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(VERDICT_SCHEMA));
  try {
    // Flag set verified against the codex CLI; adjust here if a future version renames them.
    // Read-only is conveyed by the prompt, NOT a `--sandbox read-only` flag — a deliberate design
    // choice (see PROTOCOL.md), not an oversight; don't add sandbox enforcement here.
    const args = ['exec'];
    if (resumeThread) args.push('resume', resumeThread);
    args.push('--json', '--output-schema', schemaFile, '--output-last-message', lastFile, prompt);

    const res = spawnSync('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'], // stdin closed
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    if (res.error) {
      return { ok: false, error: `could not spawn codex: ${res.error.message}` };
    }
    if (res.status !== 0) {
      return { ok: false, error: `codex exited with status ${res.status}${tail(res.stderr || res.stdout)}` };
    }

    let threadId = resumeThread || null;
    if (!resumeThread) {
      threadId = captureThreadId(res.stdout);
      if (!threadId) {
        return { ok: false, error: `could not capture Codex thread id from the --json stream${tail(res.stderr || res.stdout)}` };
      }
    }

    let verdict;
    try {
      verdict = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
    } catch (e) {
      return { ok: false, error: `could not read Codex verdict from output file: ${e.message}` };
    }
    const invalid = validateCodexVerdict(verdict);
    if (invalid) return { ok: false, error: `Codex verdict failed validation: ${invalid}` };

    return { ok: true, threadId, verdict };
  } finally {
    safeUnlink(schemaFile);
    safeUnlink(lastFile);
  }
}

function captureThreadId(stdout) {
  if (!stdout) return null;
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (!obj || (obj.type !== 'thread.started' && obj.type !== 'session.created')) continue;
    const id = obj.thread_id ?? obj.threadId ?? obj.thread?.id ?? obj.session_id ?? obj.id;
    if (id) return String(id);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verdict validation.
// ---------------------------------------------------------------------------

const isStr = (x) => typeof x === 'string';

function validateCodexVerdict(v) {
  if (!v || typeof v !== 'object') return 'not an object';
  if (!CODEX_STATUSES.has(v.status)) return `status must be one of ${[...CODEX_STATUSES].join('|')}`;
  if (!isStr(v.summary) || !isStr(v.reason) || !isStr(v.body)) return 'summary, reason, and body must be strings';
  return null;
}

function validateSessionVerdict(v) {
  if (!v || typeof v !== 'object') return 'not an object';
  if (!SESSION_STATUSES.has(v.status)) return 'status must be "continue" or "done"';
  if (!isStr(v.summary) || !isStr(v.body)) return 'summary and body must be strings';
  return null;
}

// ---------------------------------------------------------------------------
// State transitions.
// ---------------------------------------------------------------------------

function start(task, action) {
  if (!task) usageError('missing --task');
  const runId = randomUUID();
  const state = {
    runId,
    cwd: process.cwd(),
    task,
    action: action || null,
    round: 1,
    codexThread: null,
    state: 'awaiting-session',
    lastCodexVerdict: null,
    lastSessionVerdict: null,
    transcriptDigest: [],
    terminalResult: null,
  };
  saveState(state); // persist BEFORE invoking Codex, so a run always has an inspectable file

  const r = runCodex({ prompt: openerPrompt(task), resumeThread: null });
  if (!r.ok) return terminate(state, { phase: 'failed', runId, round: 1, error: r.error });

  state.codexThread = r.threadId;
  state.lastCodexVerdict = r.verdict;
  state.transcriptDigest.push({ round: 1, agent: 'codex', summary: r.verdict.summary });

  // The opener cannot end the run — the session always responds — except on a Codex `error`.
  if (r.verdict.status === 'error') {
    return terminate(state, { phase: 'failed', runId, round: 1, error: `Codex opener returned status "error": ${r.verdict.reason || r.verdict.summary}` });
  }
  saveState(state);
  emit({ phase: 'session-turn', runId, round: 1, codex: r.verdict });
}

function reportVerdict(runId, verdictJson) {
  const state = loadState(runId);
  if (state.terminalResult) return emit(state.terminalResult); // idempotent terminal replay
  if (state.state !== 'awaiting-session') {
    usageError(`run "${runId}" is not awaiting a session verdict (state: ${state.state})`);
  }
  if (!verdictJson) usageError('missing --verdict');

  let verdict;
  try { verdict = JSON.parse(verdictJson); } catch (e) { usageError(`--verdict is not valid JSON: ${e.message}`); }
  const invalid = validateSessionVerdict(verdict);
  if (invalid) usageError(`invalid session verdict: ${invalid}`);

  state.lastSessionVerdict = verdict;
  state.transcriptDigest.push({ round: state.round, agent: 'session', summary: verdict.summary });

  if (verdict.status === 'done') {
    return terminate(state, { phase: 'settled', runId, round: state.round, closing: { source: 'session', verdict } });
  }

  // continue
  if (state.round >= MAX_ROUNDS) {
    return terminate(state, {
      phase: 'exhausted', runId, round: state.round,
      lastCodexVerdict: state.lastCodexVerdict, lastSessionVerdict: verdict,
    });
  }

  state.round += 1;
  saveState(state);

  const r = runCodex({ prompt: reviewPrompt(state.task, state.action, verdict.body), resumeThread: state.codexThread });
  if (!r.ok) return terminate(state, { phase: 'failed', runId, round: state.round, error: r.error });

  state.lastCodexVerdict = r.verdict;
  state.transcriptDigest.push({ round: state.round, agent: 'codex', summary: r.verdict.summary });

  if (r.verdict.status === 'done') {
    return terminate(state, { phase: 'settled', runId, round: state.round, closing: { source: 'codex', verdict: r.verdict } });
  }
  if (r.verdict.status === 'error') {
    return terminate(state, { phase: 'failed', runId, round: state.round, error: `Codex review returned status "error": ${r.verdict.reason || r.verdict.summary}` });
  }
  // continue / needs-user -> back to the session (a needs-user body is a question it resolves inline)
  saveState(state);
  emit({ phase: 'session-turn', runId, round: state.round, codex: r.verdict });
}

function resume(runId) {
  const state = loadState(runId);
  if (state.cwd && path.resolve(state.cwd) !== path.resolve(process.cwd())) {
    process.stderr.write(`consult-codex-step: warning — this run started in ${state.cwd}; resume from there (current: ${process.cwd()})\n`);
  }
  if (state.terminalResult) return emit(state.terminalResult);
  if (state.state === 'awaiting-session') {
    return emit({ phase: 'session-turn', runId, round: state.round, codex: state.lastCodexVerdict });
  }
  usageError(`run "${runId}" is in an unexpected state: ${state.state}`);
}

function terminate(state, result) {
  state.state = result.phase; // settled | exhausted | failed
  state.terminalResult = result;
  saveState(state);
  emit(result);
}

// ---------------------------------------------------------------------------
// Plumbing.
// ---------------------------------------------------------------------------

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

// Programmer/usage errors exit non-zero with a stderr message; operational Codex failures are emitted
// as a `failed` StepResult on stdout instead (the session reads and reports them).
function usageError(msg) {
  process.stderr.write(`consult-codex-step: ${msg}\n`);
  process.exit(1);
}

function tail(text) {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  return `\n--- codex output (tail) ---\n${lines.slice(-12).join('\n')}`;
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch { /* best effort */ }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--task': out.task = argv[++i]; break;
      case '--action': out.action = argv[++i]; break;
      case '--run': out.run = argv[++i]; break;
      case '--verdict': out.verdict = argv[++i]; break;
      case '--resume': out.resume = argv[++i]; break;
      case '-h': case '--help': out.help = true; break;
      default: usageError(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printUsage() {
  process.stdout.write(`consult-codex-step — state machine for a consult-codex run

  --task "<task>" [--action "<action>"]      start a run (runs the Codex opener)
  --run <run-id> --verdict '<json>'          report the session's verdict and advance
  --resume <run-id>                          re-fetch the pending phase (cross-session)

Prints exactly one StepResult JSON object to stdout per invocation.
`);
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) { printUsage(); process.exit(0); }
else if (args.resume) resume(args.resume);
else if (args.run) reportVerdict(args.run, args.verdict);
else if (args.task !== undefined) start(args.task, args.action);
else usageError('expected: --task <task> [--action <action>] | --run <id> --verdict <json> | --resume <id>');
