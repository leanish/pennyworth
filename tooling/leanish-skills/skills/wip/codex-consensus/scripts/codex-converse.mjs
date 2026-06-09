#!/usr/bin/env node
// codex-converse.mjs — hold ONE Codex session across many rounds.
//
// First call for a <label> starts a fresh `codex exec` session and remembers
// its thread_id under that label. Every later call with the same label runs
// `codex exec resume <thread_id>`, so Codex keeps full memory of the debate.
// Distinct labels = distinct sessions, so parallel debates never cross-mix.
//
// Usage:
//   node codex-converse.mjs <label> --prompt-file <path> [--model M] [--sandbox MODE] [--effort E]
//   node codex-converse.mjs <label> --message "text"     [--model M] [--sandbox MODE] [--effort E]
//   node codex-converse.mjs <label> -- <prompt words...>  (everything after -- is the prompt)
//   echo "text" | node codex-converse.mjs <label> --stdin [...]
//
// Management:
//   node codex-converse.mjs --show <label>     print stored thread_id + metadata
//   node codex-converse.mjs --list             list all known labels
//   node codex-converse.mjs --reset <label>    forget a label (next call starts fresh)
//   node codex-converse.mjs --help
//
// stdout = Codex's final message (clean). stderr = a one-line metadata header.
// Exit code mirrors the underlying codex process; non-zero on failure.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VALID_SANDBOX = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_EFFORT = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
// Labels become filenames and state keys, so keep them to a safe slug, force an
// alphanumeric start (rejects ".", "..", "../x", leading dot/dash), and bound the
// length so they always fit in a filename.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LABEL_LEN = 64;
const STATE_DIR = join(homedir(), ".claude", "codex-converse");
// One file per label: concurrent calls on different labels touch different files,
// so there is no shared-file read-modify-write race to lose updates.
const LABELS_DIR = join(STATE_DIR, "labels");
const LEGACY_STATE_FILE = join(STATE_DIR, "sessions.json"); // pre-per-label format
const LOG_DIR = join(STATE_DIR, "logs");
const LOG_KEEP = 100; // most-recent logs to retain; older ones are pruned

// Codex runs at this effort unless the caller overrides with --effort. Kept high
// on purpose: an independent adversarial reviewer is worth the extra reasoning.
const DEFAULT_EFFORT = "xhigh";

function die(message, code = 1) {
  process.stderr.write(`[codex-converse] error: ${message}\n`);
  process.exit(code);
}

// A label becomes a filename and a key, so every path that turns input into a
// label must validate first — including --show, --reset, and legacy migration,
// not just the normal run path (else `--reset ../../x` escapes LABELS_DIR).
function isValidLabel(label) {
  return typeof label === "string" && label.length <= MAX_LABEL_LEN && LABEL_RE.test(label);
}

function requireValidLabel(label) {
  if (!isValidLabel(label)) {
    die(
      `invalid label "${label}" — use letters, digits, . _ - ` +
        `(start alphanumeric, max ${MAX_LABEL_LEN} chars)`
    );
  }
}

function recordPath(label) {
  return join(LABELS_DIR, `${label}.json`);
}

// mkdir is mode-on-create only, so chmod existing dirs too (state holds session
// pointers and logs hold raw agent output — keep them owner-only).
function ensureDirs() {
  mkdirSync(LABELS_DIR, { recursive: true, mode: 0o700 });
  for (const dir of [STATE_DIR, LABELS_DIR]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
}

function writeFileAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function loadRecord(label) {
  const path = recordPath(label);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(readFileSync(path, "utf8"));
    if (!rec || typeof rec !== "object") throw new Error("unexpected record shape");
    return rec;
  } catch {
    // Don't silently lose a session: preserve the corrupt file and warn loudly.
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, backup);
      process.stderr.write(`[codex-converse] warning: corrupt record backed up to ${backup}\n`);
    } catch {
      /* best effort */
    }
    return null;
  }
}

function saveRecord(label, record) {
  ensureDirs();
  writeFileAtomic(recordPath(label), JSON.stringify(record, null, 2));
}

function deleteRecord(label) {
  const path = recordPath(label);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

function listRecords() {
  let files;
  try {
    files = readdirSync(LABELS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return {};
  }
  const out = {};
  for (const file of files) {
    const label = file.slice(0, -5);
    const rec = loadRecord(label);
    if (rec) out[label] = rec;
  }
  return out;
}

// One-time migration from the old single sessions.json to per-label files.
function migrateLegacyState() {
  if (!existsSync(LEGACY_STATE_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_STATE_FILE, "utf8"));
    const labels = parsed?.labels ?? {};
    ensureDirs();
    for (const [label, rec] of Object.entries(labels)) {
      if (!isValidLabel(label)) {
        // Legacy state predates label validation; never write an unsafe label as a path.
        process.stderr.write(`[codex-converse] warning: skipping unsafe legacy label "${label}" during migration\n`);
        continue;
      }
      if (!existsSync(recordPath(label))) {
        saveRecord(label, rec); // one place owns "persist a record"
      }
    }
  } catch {
    /* leave a corrupt legacy file in place rather than lose it */
    return;
  }
  try {
    renameSync(LEGACY_STATE_FILE, `${LEGACY_STATE_FILE}.migrated-${Date.now()}`);
  } catch {
    /* best effort */
  }
}

function parseArgs(argv) {
  const opts = { label: null, promptFile: null, message: null, stdin: false, promptParts: [] };
  let sawDoubleDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (sawDoubleDash) {
      opts.promptParts.push(arg);
      continue;
    }
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--list":
        opts.list = true;
        break;
      case "--show":
        opts.show = argv[++i];
        break;
      case "--reset":
        opts.reset = argv[++i];
        break;
      case "--prompt-file":
        opts.promptFile = argv[++i];
        break;
      case "--message":
        opts.message = argv[++i];
        break;
      case "--stdin":
        opts.stdin = true;
        break;
      case "--model":
        opts.model = argv[++i];
        break;
      case "--sandbox":
        opts.sandbox = argv[++i];
        break;
      case "--effort":
        opts.effort = argv[++i];
        break;
      case "--trace":
        opts.trace = true;
        break;
      case "--":
        sawDoubleDash = true;
        break;
      default:
        if (arg.startsWith("-")) {
          die(`unknown option: ${arg}`);
        } else if (opts.label == null) {
          opts.label = arg;
        } else {
          opts.promptParts.push(arg);
        }
    }
  }
  return opts;
}

function resolvePrompt(opts) {
  if (opts.promptFile) {
    if (!existsSync(opts.promptFile)) {
      die(`prompt file not found: ${opts.promptFile}`);
    }
    return readFileSync(opts.promptFile, "utf8");
  }
  if (opts.message != null) {
    return opts.message;
  }
  if (opts.stdin) {
    return readFileSync(0, "utf8");
  }
  if (opts.promptParts.length > 0) {
    return opts.promptParts.join(" ");
  }
  return null;
}

// All knowledge of Codex's JSONL event shapes lives here. One pass over the
// event stream yields everything main() needs; `lastMsgText` is the `-o`
// last-message file (preferred for the final message, with the agent_message
// event as fallback). Pure (no I/O) so it can be unit-tested without spawning
// codex — the whole point of consolidating the four old single-purpose parsers.
export function parseTurnOutcome(stdout, lastMsgText = "") {
  let threadId = null;
  let usage = null;
  let error = "";
  let agentMessage = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // not a JSON line
    }
    if (!threadId && typeof event.thread_id === "string" && event.thread_id) {
      threadId = event.thread_id; // first thread.started wins
    }
    const type = String(event?.type ?? "");
    if (type === "turn.completed" && event.usage) {
      usage = event.usage; // last one wins
    } else if (type === "error" || type === "turn.failed") {
      const msg = event?.message ?? event?.error?.message;
      if (msg) error = msg; // last failure wins
    } else if (type === "item.completed" && event?.item?.type === "agent_message" && typeof event.item.text === "string") {
      agentMessage = event.item.text; // last assistant message wins
    }
  }
  const trimmedLast = (lastMsgText || "").trim();
  return { threadId, usage, error, message: trimmedLast || agentMessage.trim() };
}

function formatUsage(usage) {
  if (!usage) return "";
  const { input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: r } = usage;
  return ` tokens(in=${i ?? "?"},cached=${c ?? 0},out=${o ?? "?"}${r != null ? `,reasoning=${r}` : ""})`;
}

// Prune the log dir to the most-recent LOG_KEEP files (oldest by mtime go first).
function pruneLogs() {
  let entries;
  try {
    entries = readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  if (entries.length <= LOG_KEEP) return;
  const byAge = entries
    .map((f) => {
      const full = join(LOG_DIR, f);
      try {
        return { full, mtime: statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  for (const { full } of byAge.slice(0, byAge.length - LOG_KEEP)) {
    rmSync(full, { force: true });
  }
}

function printHelp() {
  process.stdout.write(
    `codex-converse — hold one Codex session across many rounds.\n\n` +
      `  node codex-converse.mjs <label> --prompt-file <path> [--model M] [--sandbox MODE] [--effort E]\n` +
      `  node codex-converse.mjs <label> --message "text"\n` +
      `  node codex-converse.mjs <label> -- <prompt...>\n` +
      `  echo text | node codex-converse.mjs <label> --stdin\n\n` +
      `  --show <label> | --list | --reset <label>\n\n` +
      `  --trace          echo the full codex JSONL event stream to stderr\n` +
      `Every call's raw events are saved to ~/.claude/codex-converse/logs/ regardless.\n` +
      `The stderr header reports per-turn token usage (where the quota goes).\n\n` +
      `Effort defaults to xhigh; override with --effort (none|minimal|low|medium|high|xhigh).\n` +
      `Sandbox modes: read-only | workspace-write | danger-full-access (default read-only).\n` +
      `Sandbox/model/effort are fixed at session start; resume reuses them (flags ignored).\n` +
      `Run at most one in-flight call per label; distinct labels may run concurrently.\n`
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  migrateLegacyState();

  if (opts.list) {
    const records = listRecords();
    const labels = Object.keys(records);
    if (!labels.length) {
      process.stdout.write("(no active codex-converse sessions)\n");
      return;
    }
    for (const label of labels) {
      const rec = records[label];
      process.stdout.write(
        `${label}\tthread=${rec.threadId}\trounds=${rec.rounds}\tsandbox=${rec.sandbox}\tcwd=${rec.cwd}\n`
      );
    }
    return;
  }

  if (opts.show) {
    requireValidLabel(opts.show);
    const rec = loadRecord(opts.show);
    if (!rec) die(`no session for label: ${opts.show}`);
    process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
    return;
  }

  if (opts.reset) {
    requireValidLabel(opts.reset);
    process.stdout.write(
      deleteRecord(opts.reset) ? `reset: ${opts.reset}\n` : `(nothing to reset for ${opts.reset})\n`
    );
    return;
  }

  if (!opts.label) die("a <label> is required");
  requireValidLabel(opts.label);

  const prompt = resolvePrompt(opts);
  if (prompt == null || prompt.trim() === "") {
    die("a prompt is required (--prompt-file, --message, --stdin, or -- <text>)");
  }

  if (opts.sandbox && !VALID_SANDBOX.has(opts.sandbox)) {
    die(`invalid --sandbox: ${opts.sandbox} (read-only|workspace-write|danger-full-access)`);
  }
  if (opts.effort && !VALID_EFFORT.has(opts.effort)) {
    die(`invalid --effort: ${opts.effort} (none|minimal|low|medium|high|xhigh)`);
  }

  const existing = loadRecord(opts.label);
  const action = existing ? "resume" : "start";

  const tmpDir = mkdtempSync(join(tmpdir(), "codex-converse-"));
  const lastMsgFile = join(tmpDir, "last.txt");

  const args = ["exec"];
  if (action === "resume") {
    args.push("resume", existing.threadId);
  }
  args.push("--json", "--skip-git-repo-check", "-o", lastMsgFile);

  // Sandbox, model, and effort are locked at session start; a resume reuses the
  // stored values and ignores any flags (codex resume can't change them anyway).
  if (action === "resume" && (opts.sandbox || opts.model || opts.effort)) {
    process.stderr.write(
      "[codex-converse] note: --sandbox/--model/--effort are ignored on resume (locked at session start)\n"
    );
  }
  const sandbox = existing ? existing.sandbox : opts.sandbox || "read-only";
  if (action === "start") {
    args.push("--sandbox", sandbox);
  }
  const model = existing ? existing.model : opts.model || null;
  if (model) {
    args.push("--model", model);
  }
  const effort = existing ? existing.effort : opts.effort || DEFAULT_EFFORT;
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

  // Send the prompt over stdin (`-`), never as a process argument: avoids the
  // ARG_MAX ceiling and keeps prompt contents out of process listings.
  args.push("-");

  const result = spawnSync("codex", args, {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

  if (result.error) {
    rmSync(tmpDir, { recursive: true, force: true });
    die(`failed to launch codex: ${result.error.message}`);
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const lastMsgText = existsSync(lastMsgFile) ? readFileSync(lastMsgFile, "utf8") : "";
  rmSync(tmpDir, { recursive: true, force: true });

  // One pass over the event stream → everything main() needs.
  const outcome = parseTurnOutcome(stdout, lastMsgText);

  // Always persist the raw event stream so any turn can be inspected afterwards.
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(LOG_DIR, 0o700); // tighten a pre-existing dir; mkdir mode is create-only
  } catch {
    /* best effort */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOG_DIR, `${opts.label}-${stamp}.jsonl`);
  writeFileSync(logFile, stdout + (stderr ? `\n--- codex stderr ---\n${stderr}\n` : ""), { mode: 0o600 });
  pruneLogs();

  if (opts.trace) {
    process.stderr.write(`--- codex event trace: codex ${args.join(" ")} ---\n`);
    process.stderr.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
    if (stderr) process.stderr.write(`--- codex stderr ---\n${stderr}\n`);
    process.stderr.write(`--- end trace ---\n`);
  }

  if (result.status !== 0) {
    if (stderr) process.stderr.write(stderr);
    const detail = outcome.error ? `: ${outcome.error}` : ` (status ${result.status})`;
    die(`codex ${action} failed${detail} [trace: ${logFile}]`, result.status || 1);
  }

  const threadId = action === "start" ? outcome.threadId : existing.threadId;
  if (action === "start" && !threadId) {
    process.stderr.write(stdout.slice(0, 2000));
    die("could not capture thread_id from codex output");
  }

  const message = outcome.message;

  const now = new Date().toISOString();
  const rounds = (existing?.rounds ?? 0) + 1;
  // One file per label, so a concurrent call on a different label can't clobber
  // this record (no shared-file read-modify-write).
  saveRecord(opts.label, {
    threadId,
    model: model || null,
    sandbox,
    effort: effort || null,
    cwd: process.cwd(),
    createdAt: existing?.createdAt ?? now,
    lastAt: now,
    rounds,
  });

  process.stderr.write(
    `[codex-converse] label=${opts.label} action=${action} thread=${threadId} round=${rounds}` +
      `${model ? ` model=${model}` : ""} sandbox=${sandbox}${formatUsage(outcome.usage)}` +
      ` log=${logFile}\n`
  );
  process.stdout.write(message + (message.endsWith("\n") ? "" : "\n"));
}

// Run the CLI only when executed directly; importing (e.g. from tests) does not.
// Guard argv[1] — a bare dynamic import (`node -e "import(...)"`) leaves it unset.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
