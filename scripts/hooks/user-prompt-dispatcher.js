#!/usr/bin/env node
/**
 * UserPromptSubmit dispatcher.
 *
 * Collapses the three prior UserPromptSubmit hooks (inject-context.sh,
 * inject-rules.js, context-budget.js) into a single process so Claude Code
 * sees one `UserPromptSubmit hook success:` block per prompt and we avoid
 * re-parsing stdin N times.
 *
 * Strategy:
 *   1. Read stdin (JSON from Claude Code) ONCE.
 *   2. Spawn inject-context.sh synchronously, piping the raw JSON to its
 *      stdin. Capture its stdout.  (Kept as a subprocess because the bash
 *      logic — jq-based sidecar writes, session-file parsing — is battle-
 *      tested and non-trivial to port.)
 *   3. Run inject-rules impl in-process.
 *   4. Run context-budget impl in-process.
 *   5. Concatenate outputs (separator blank line between non-empty blocks)
 *      and print to stdout.
 *
 * Every handler is wrapped in try/catch so a failure in one never prevents
 * the others from running. Hook exits 0 unconditionally.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const injectContextImpl = require('./inject-context-impl');
const injectRules = require('./inject-rules-impl');
const contextBudget = require('./context-budget-impl');
const { findWorkspaceRoot } = require('./_lib/workspace-root');

/**
 * Append a timing record to .ai-memory/hook-timings.jsonl.
 *
 * Truly fire-and-forget: uses async fs.appendFile with an ignored callback so
 * an NFS stall or full disk cannot block the hook's event loop. Any error is
 * swallowed — instrumentation must never affect prompt latency. The mkdir is
 * also async; if it fails, appendFile will fail too and both get swallowed.
 *
 * Used to collect real-world p95 before tuning execFileSync / hook timeouts.
 */
function recordTiming(workspaceRoot, record) {
  const dir = path.join(workspaceRoot, '.ai-memory');
  const file = path.join(dir, 'hook-timings.jsonl');
  const line = JSON.stringify(record) + '\n';
  fs.mkdir(dir, { recursive: true }, () => {
    fs.appendFile(file, line, () => { /* errors ignored on purpose */ });
  });
}

function readStdin() {
  // Try fd 0 first (most reliable on Linux when CC pipes payload)
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw) return raw;
  } catch { /* fd 0 unreadable, try next */ }

  // Fallback: /dev/stdin (POSIX symbolic path; throws on Windows)
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf8');
    if (raw) return raw;
  } catch { /* not on Windows or path unavailable */ }

  // Final fallback: synchronous drain of process.stdin via fs.readSync loop
  try {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let bytesRead;
    while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

function parseInput(raw) {
  const parsed = { prompt: '', cwd: '', sessionId: '', transcriptPath: '' };
  if (!raw) return parsed;
  try {
    const obj = JSON.parse(raw);
    parsed.prompt = obj.prompt || '';
    parsed.cwd = obj.cwd || '';
    parsed.sessionId = obj.session_id || '';
    parsed.transcriptPath = obj.transcript_path || '';
  } catch {
    parsed.prompt = raw;
  }
  return parsed;
}

/**
 * Resolve the session_id from per-session sources only.
 *
 * CC's UserPromptSubmit hook payload sometimes omits `session_id` on Linux.
 * Recovery is by extracting the UUID from the transcript_path filename
 * (~/.claude/projects/{slug}/{uuid}.jsonl) — that path is unique per CC
 * session and never cross-contaminates between terminals.
 *
 * Global files (cc-session-id, current.yaml) are deliberately NOT consulted:
 * with multiple terminals open they hold whichever wrote last, which would
 * key this prompt's sidecar onto another terminal's session — silently
 * cross-attributing tokens, project, and jira_ticket on the dashboard.
 * If neither stdin nor transcript_path yield an id, return '' and let
 * sidecar writes downstream short-circuit.
 */
function resolveSessionId(stdinSessionId, transcriptPath) {
  if (stdinSessionId) return stdinSessionId;
  if (transcriptPath) {
    const base = transcriptPath.split('/').pop() || '';
    const uuid = base.replace(/\.jsonl$/, '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return uuid;
    }
  }
  return '';
}

function runInjectContext(workspaceRoot, rawStdin) {
  try {
    return (injectContextImpl.run({ rawStdin, workspaceRoot }) || '').trim();
  } catch {
    return '';
  }
}

function runInjectRules(workspaceRoot, parsed) {
  try {
    return (injectRules.run({
      prompt: parsed.prompt,
      cwd: parsed.cwd,
      sessionId: parsed.sessionId,
      workspaceRoot,
    }) || '').trim();
  } catch {
    return '';
  }
}

function runContextBudget(workspaceRoot, parsed) {
  try {
    return (contextBudget.run({
      sessionId: parsed.sessionId,
      workspaceRoot,
    }) || '').trim();
  } catch {
    return '';
  }
}

function main() {
  const workspaceRoot = findWorkspaceRoot();
  const rawStdin = readStdin();
  const parsed = parseInput(rawStdin);
  parsed.sessionId = resolveSessionId(parsed.sessionId, parsed.transcriptPath);

  const t0 = Date.now();
  const ctxBlock = runInjectContext(workspaceRoot, rawStdin);
  const t1 = Date.now();
  const rulesBlock = runInjectRules(workspaceRoot, parsed);
  const t2 = Date.now();
  const budgetBlock = runContextBudget(workspaceRoot, parsed);
  const t3 = Date.now();

  const blocks = [ctxBlock, rulesBlock, budgetBlock].filter(Boolean);
  if (blocks.length > 0) {
    process.stdout.write(blocks.join('\n\n') + '\n');
  }

  recordTiming(workspaceRoot, {
    ts: new Date().toISOString(),
    sessionId: parsed.sessionId,
    inject_context_ms: t1 - t0,
    inject_rules_ms: t2 - t1,
    context_budget_ms: t3 - t2,
    total_ms: t3 - t0,
    blocks_emitted: blocks.length,
  });
}

main();
// Intentionally no process.exit() — let the event loop drain so the async
// recordTiming write actually lands. The only outstanding work after main()
// returns is that single mkdir+appendFile pair (typically <10 ms); Claude
// Code's hook timeout enforces the upper bound if anything ever stalls.
// Explicit exit here previously dropped every real-invocation timing record
// and was only caught when hook-timings.jsonl stayed empty while the
// dispatcher was clearly firing (sidecar prompts counter advancing).
