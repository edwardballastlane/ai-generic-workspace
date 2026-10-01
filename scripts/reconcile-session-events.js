#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const { readTranscript } = require('./_lib/transcript');
const { extractTask, extractJiraTicket, isWeakTask, looksLikeSecret } = require('./_lib/heuristics');
const { atomicWrite } = require('./_lib/process');

// ── Constants ─────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node scripts/reconcile-session-events.js [options]

Options:
  --audit              Show counts and up to 5 samples per category. Default. Read-only.
  --fill               Fill ONLY empty task/jira fields from transcript. Implies write.
  --reconcile          Overwrite recorded fields when transcript disagrees.
                       (--reconcile implies --fill behavior too)
  --apply-recaps       LLM-quality recap mode for weak task labels. Mutually
                       exclusive with --fill/--reconcile. Requires --apply to write.
  --since <ISO>        Restrict --apply-recaps to events with ts >= ISO date.
  --max-cost <usd>     Abort --apply-recaps once cumulative estimated cost > value.
                       Default 30.
  --recap-model <id>   Model alias or ID for --apply-recaps. Default 'sonnet'.
                       Use 'haiku' for cheaper runs (lower output quality).
  --concurrency <n>    Max concurrent recap invocations (--apply-recaps only).
                       Integer in [1, 20]. Default 1 (sequential).
  --session <sid>      Scope to one session_id (UUID).
  --apply              Required for any write mode (dry-run without it).
                       Requires --fill, --reconcile, or --apply-recaps.
  --events <path>      Override events file (default .ai-memory/session-end-events.jsonl)
  --transcript-dir <p> Override transcript dir (default ~/.claude/projects/<flat-cwd>/)
  --help               Print usage and exit 0.
`.trim();

const DEFAULT_MAX_COST_USD = 30;
const PER_RECAP_COST_ESTIMATE_USD = 0.01;
const DEFAULT_RECAP_MODEL = 'sonnet';
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 20;
const RECAP_TIMEOUT_MS = 120_000;
const RECAP_MAX_TASK_LEN = 200;
const FIXED_PROMPT = 'Summarize what was actually accomplished in this session in 1-2 sentences. Focus on concrete outcomes (commits, PRs, decisions). No fluff. Under 200 chars.';

const SAMPLE_LIMIT = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    audit: false, fill: false, reconcile: false, apply: false,
    applyRecaps: false, since: null, maxCost: DEFAULT_MAX_COST_USD,
    recapModel: DEFAULT_RECAP_MODEL, concurrency: DEFAULT_CONCURRENCY,
    session: null, eventsFile: null, transcriptDir: null, help: false,
  };

  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--help') { args.help = true; }
    else if (a === '--audit') { args.audit = true; }
    else if (a === '--fill') { args.fill = true; }
    else if (a === '--reconcile') { args.reconcile = true; }
    else if (a === '--apply') { args.apply = true; }
    else if (a === '--apply-recaps') { args.applyRecaps = true; }
    else if (a === '--since') { args.since = raw[++i] || null; }
    else if (a === '--max-cost') {
      const v = Number(raw[++i]);
      if (!Number.isFinite(v) || v < 0) {
        process.stderr.write(`--max-cost requires a non-negative number\n\n${USAGE}\n`);
        process.exit(1);
      }
      args.maxCost = v;
    }
    else if (a === '--recap-model') {
      const v = raw[++i];
      if (!v) {
        process.stderr.write(`--recap-model requires a value\n\n${USAGE}\n`);
        process.exit(1);
      }
      args.recapModel = v;
    }
    else if (a === '--concurrency') {
      const v = Number(raw[++i]);
      if (!Number.isInteger(v) || v < 1 || v > MAX_CONCURRENCY) {
        process.stderr.write(
          `--concurrency requires an integer in [1, ${MAX_CONCURRENCY}]\n\n${USAGE}\n`
        );
        process.exit(1);
      }
      args.concurrency = v;
    }
    else if (a === '--session') { args.session = raw[++i] || null; }
    else if (a === '--events') { args.eventsFile = raw[++i] || null; }
    else if (a === '--transcript-dir') { args.transcriptDir = raw[++i] || null; }
    else {
      process.stderr.write(`Unknown option: ${a}\n\n${USAGE}\n`);
      process.exit(1);
    }
  }

  if (args.applyRecaps && (args.fill || args.reconcile)) {
    process.stderr.write(
      '--apply-recaps cannot combine with --fill or --reconcile\n\n' + USAGE + '\n'
    );
    process.exit(1);
  }

  if (!args.fill && !args.reconcile && !args.applyRecaps && !args.audit) args.audit = true;
  return args;
}

function isValidUuid(s) { return UUID_RE.test(s); }

function sha1(buf) { return createHash('sha1').update(buf).digest('hex'); }

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Classify a session_end event against its transcript-derived values.
 *
 * Categories:
 *   'no_transcript'      — transcript file not found on disk
 *   'match'              — recorded values agree with transcript (or both empty)
 *   'empty_fillable'     — at least one recorded field is empty, transcript has a value
 *   'sidecar_leak'       — recorded jira_ticket is set but transcript has none
 *   'mid_session_drift'  — recorded jira_ticket differs from transcript's ticket
 */
function classify(event, derived, hasTranscript) {
  if (!hasTranscript) return { category: 'no_transcript', derived: null };

  const recTask = event.task || '';
  const recJira = event.jira_ticket || '';
  const derTask = derived.task || '';
  const derJira = derived.jira_ticket || '';

  if (recJira !== '' && derJira === '') return { category: 'sidecar_leak', derived };
  if (recJira !== '' && derJira !== '' && recJira !== derJira) {
    return { category: 'mid_session_drift', derived };
  }

  const taskFillable = recTask === '' && derTask !== '';
  const jiraFillable = recJira === '' && derJira !== '';
  if (taskFillable || jiraFillable) return { category: 'empty_fillable', derived };

  return { category: 'match', derived };
}

// ── Apply correction ──────────────────────────────────────────────────────────

/**
 * Return a corrected copy of `event` given derived transcript values and mode.
 * Does not mutate the original object.
 *
 * mode 'fill':       only write empty fields
 * mode 'reconcile':  fill empties AND overwrite disagreements
 */
function applyCorrection(event, derived, mode) {
  const updated = { ...event };

  if (mode === 'fill') {
    if ((updated.task || '') === '' && (derived.task || '') !== '') {
      updated.task = derived.task;
    }
    if ((updated.jira_ticket || '') === '' && (derived.jira_ticket || '') !== '') {
      updated.jira_ticket = derived.jira_ticket;
    }
  } else if (mode === 'reconcile') {
    if ((derived.task || '') !== '' || (updated.task || '') !== '') {
      updated.task = derived.task || updated.task;
    }
    if (derived.jira_ticket !== undefined) {
      updated.jira_ticket = derived.jira_ticket;
    }
  }

  return updated;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatSample(event, derived) {
  const ts = event.ts || '';
  const sid = (event.session_id || '').slice(0, 8);
  const recJira = event.jira_ticket || '(empty)';
  const derJira = (derived && derived.jira_ticket) || '(empty)';
  const task = (event.task || '').slice(0, 60);
  return `  ${ts} | ${sid} | jira: ${recJira} → ${derJira} | task: ${task}`;
}

// ── Helpers extracted from main() ─────────────────────────────────────────────

/**
 * Parse session_end rows from raw file content. Skips malformed JSON and
 * non-session_end rows. Returns the parsed rows.
 */
function parseSessionEndRows(rawContent) {
  const rows = [];
  for (const line of rawContent.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'session_end' && row.session_id) rows.push(row);
  }
  return rows;
}

/**
 * For each unique session_id in `events`, read the transcript (if present)
 * and derive task/jira_ticket via the same heuristic the live hook uses.
 *
 * Returns Map<sid, { derived, hasTranscript }>.
 */
async function buildSessionMap(events, transcriptDir) {
  const sessionMap = new Map();
  const seen = new Set();

  for (const ev of events) {
    const sid = ev.session_id;
    if (seen.has(sid)) continue;
    seen.add(sid);

    if (!isValidUuid(sid)) {
      sessionMap.set(sid, { derived: null, hasTranscript: false });
      continue;
    }

    const transcriptPath = path.join(transcriptDir, `${sid}.jsonl`);
    if (!fs.existsSync(transcriptPath)) {
      sessionMap.set(sid, { derived: null, hasTranscript: false });
      continue;
    }

    const { userPrompts } = await readTranscript(transcriptPath);
    sessionMap.set(sid, {
      derived: {
        task: extractTask(userPrompts),
        jira_ticket: extractJiraTicket(userPrompts),
      },
      hasTranscript: true,
    });
  }

  return sessionMap;
}

/**
 * Classify every session_end event using the prebuilt sessionMap.
 * Returns array of { ev, derived, category }.
 */
function classifyAll(events, sessionMap) {
  return events.map(ev => {
    const { derived, hasTranscript } = sessionMap.get(ev.session_id) ||
      { derived: null, hasTranscript: false };
    const { category } = classify(ev, derived, hasTranscript);
    return { ev, derived, category };
  });
}

/**
 * Tally categories across the given classified rows.
 */
function tallyCounts(classified) {
  const counts = {
    match: 0, empty_fillable: 0, sidecar_leak: 0,
    mid_session_drift: 0, no_transcript: 0,
  };
  for (const c of classified) counts[c.category] = (counts[c.category] || 0) + 1;
  return counts;
}

/**
 * Print the audit-style report (counts + samples) for the in-scope rows.
 */
function printAuditReport(counts, inScope, opts) {
  const total = inScope.length;
  const transcriptsOnDisk = total - counts.no_transcript;

  process.stdout.write(`Total session_end events:  ${total}\n`);
  process.stdout.write(`Transcripts on disk:       ${transcriptsOnDisk}\n`);
  process.stdout.write(`\nCategories:\n`);
  process.stdout.write(`  match:              ${counts.match}\n`);
  process.stdout.write(`  empty_fillable:     ${counts.empty_fillable}\n`);
  process.stdout.write(`  sidecar_leak:       ${counts.sidecar_leak}\n`);
  process.stdout.write(`  mid_session_drift:  ${counts.mid_session_drift}\n`);
  process.stdout.write(`  no_transcript:      ${counts.no_transcript}\n`);

  const cats = opts.categoriesToShow;
  if (cats.length > 0) process.stdout.write('\n');

  for (const cat of cats) {
    const samples = inScope.filter(c => c.category === cat).slice(0, SAMPLE_LIMIT);
    if (samples.length === 0) continue;
    process.stdout.write(`=== ${cat} (showing up to ${SAMPLE_LIMIT}) ===\n`);
    for (const s of samples) process.stdout.write(formatSample(s.ev, s.derived) + '\n');
    process.stdout.write('\n');
  }
}

/**
 * Race-guarded atomic rewrite. Takes a fully-populated correctionMap keyed by
 * `${session_id}||${ts}` and rewrites only those rows. Shared between
 * fill/reconcile (applyWrites) and --apply-recaps (runApplyRecaps).
 */
async function writeCorrections(correctionMap, ctx) {
  // Race guard: re-read and verify the file was only APPENDED to since first
  // read (long --apply-recaps runs span minutes, during which session-stop
  // hooks legitimately append new rows). Reject any modification of the
  // original prefix — that would mean a concurrent reconciler/edit clobbered
  // rows we expected to overwrite.
  const recheckRaw = await fsp.readFile(ctx.eventsFile, 'utf8');
  if (!recheckRaw.startsWith(ctx.rawContent)) {
    process.stderr.write(
      'ERROR: events file modified (not appended) during apply. Re-run.\n'
    );
    process.exit(2);
  }
  const appendedSuffix = recheckRaw.slice(ctx.rawContent.length);

  const allLines = ctx.rawContent.split('\n');
  const newLines = allLines.map(line => {
    if (!line.trim()) return line;
    let row;
    try { row = JSON.parse(line); } catch { return line; }
    if (row.type !== 'session_end' || !row.session_id) return line;
    const corrected = correctionMap.get(`${row.session_id}||${row.ts}`);
    return corrected ? JSON.stringify(corrected) : line;
  });
  const newContent = newLines.join('\n') + appendedSuffix;

  if (allLines.length !== newLines.length) {
    process.stderr.write(
      `ERROR: line count changed (${allLines.length} → ${newLines.length}), aborting.\n`
    );
    process.exit(1);
  }
  if (newContent.length < recheckRaw.length * 0.5) {
    process.stderr.write(`ERROR: output < 50% of input size — possible truncation. Aborting.\n`);
    process.exit(1);
  }

  const backupPath = `${ctx.eventsFile}.bak.${Date.now()}`;
  await fsp.copyFile(ctx.eventsFile, backupPath);
  process.stdout.write(`Backup: ${backupPath}\n`);
  await atomicWrite(ctx.eventsFile, newContent);
}

/**
 * Build correction map from classified rows then race-guard + atomic write.
 */
async function applyWrites(inScope, mode, actionableCategories, ctx) {
  const correctionMap = new Map();
  for (const { ev, derived, category } of inScope) {
    if (!actionableCategories.has(category)) continue;
    if (!derived) continue;
    correctionMap.set(`${ev.session_id}||${ev.ts}`, applyCorrection(ev, derived, mode));
  }

  if (correctionMap.size === 0) {
    process.stdout.write('Nothing to apply.\n');
    return;
  }

  await writeCorrections(correctionMap, ctx);
  process.stdout.write(`Applied. Changed ${correctionMap.size} rows.\n`);
}

// ── --apply-recaps mode ───────────────────────────────────────────────────────

/**
 * Invoke `claude --model <m> --print --resume <sid> "<FIXED_PROMPT>"` and return
 * a Promise<Result>. Async so callers can run multiple invocations in parallel
 * with bounded concurrency.
 *
 * @param {string} sessionId
 * @param {string} model       Model alias ('sonnet', 'haiku', 'opus') or full ID.
 * @returns {Promise<{ ok: true, task: string, rawStdout: string }
 *                 | { ok: false, reason: string }>}
 */
function invokeRecapAsync(sessionId, model) {
  return new Promise((resolve) => {
    let child;
    try {
      // stderr: 'ignore' — `claude --print` writes verbose progress to stderr
      // (>64 KB on long sessions). Capturing without draining deadlocks the
      // child once the OS pipe buffer fills. We only need stdout for the recap
      // result + the exit code for skip reasons; stderr text is not useful
      // per-event, so discard it.
      child = spawn('claude', [
        '--model', model, '--print', '--resume', sessionId, FIXED_PROMPT
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      resolve({ ok: false, reason: `spawn error: ${err && err.message || 'unknown'}` });
      return;
    }

    let stdout = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      settle({ ok: false, reason: `timeout after ${RECAP_TIMEOUT_MS}ms` });
    }, RECAP_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, reason: `spawn error: ${err.code || err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle({ ok: false, reason: `claude exit ${code}` });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) { settle({ ok: false, reason: 'empty stdout' }); return; }
      if (looksLikeSecret(trimmed)) {
        settle({ ok: false, reason: 'secret-shaped output' }); return;
      }
      const task = trimmed.replace(/\s+/g, ' ').slice(0, RECAP_MAX_TASK_LEN);
      settle({ ok: true, task, rawStdout: trimmed });
    });
  });
}

/**
 * Run `fn(item, index)` over `items` with at most `concurrency` invocations
 * in flight at once. Returns an array of results in input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency  Integer >= 1.
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Filter parsed events to those eligible for /recap backfill.
 */
function selectRecapCandidates(events, args) {
  return events.filter(ev =>
    ev.task_source !== 'recap' &&
    isWeakTask(ev.task || '') &&
    isValidUuid(ev.session_id) &&
    (!args.since || (ev.ts && ev.ts >= args.since)) &&
    (!args.session || ev.session_id === args.session)
  );
}

/**
 * Print the dry-run summary for --apply-recaps.
 */
function printRecapDryRun(candidates) {
  process.stdout.write(`Would recap ${candidates.length} events.\n`);
  if (candidates.length === 0) return;
  process.stdout.write('Sample session IDs:\n');
  for (const c of candidates.slice(0, SAMPLE_LIMIT)) {
    process.stdout.write(
      `  ${c.ts} | ${c.session_id} | task: ${(c.task || '').slice(0, 60)}\n`
    );
  }
}

/**
 * Run /recap for each candidate (up to budget cap) with bounded concurrency.
 * Build a correction map keyed by `${session_id}||${ts}`.
 *
 * Cost ceiling: pre-compute the maximum number of events we can afford
 * (`maxByBudget = floor(maxCost / PER_RECAP_COST_ESTIMATE_USD)`). This is
 * exactly equivalent to the prior sequential `nextCost > maxCost` early-stop
 * because the per-call cost is a fixed constant — slicing up-front avoids
 * cross-worker cost-counter synchronization.
 *
 * @returns {Promise<{ corrections: Map, updated: number, skipped: number,
 *                     estCostUsd: number, costCeilingHit: boolean }>}
 */
async function buildRecapCorrectionsAsync(candidates, maxCost, model, concurrency) {
  // Group candidates by session_id: a single recap describes the whole session,
  // so we invoke claude once per unique sid and apply the result to every row.
  // Cuts cost (and transcript bloat) dramatically when a session has many rows.
  const bySid = new Map();
  for (const ev of candidates) {
    if (!bySid.has(ev.session_id)) bySid.set(ev.session_id, []);
    bySid.get(ev.session_id).push(ev);
  }
  const uniqueSids = [...bySid.keys()];

  const maxByBudget = Math.floor(maxCost / PER_RECAP_COST_ESTIMATE_USD);
  const eligibleSids = uniqueSids.slice(0, Math.max(0, maxByBudget));
  const costCeilingHit = uniqueSids.length > eligibleSids.length;
  if (costCeilingHit) {
    const cappedCost = (eligibleSids.length + 1) * PER_RECAP_COST_ESTIMATE_USD;
    process.stdout.write(
      `Cost ceiling reached: $${cappedCost.toFixed(2)} > $${maxCost.toFixed(2)}. Stopping.\n`
    );
  }

  const results = await mapWithConcurrency(eligibleSids, concurrency,
    (sid) => invokeRecapAsync(sid, model));

  const corrections = new Map();
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < eligibleSids.length; i++) {
    const sid = eligibleSids[i];
    const result = results[i];
    const eventsForSid = bySid.get(sid);
    if (!result.ok) {
      skipped += eventsForSid.length;
      process.stderr.write(
        `SKIP ${sid.slice(0, 8)} (${eventsForSid.length} rows): ${result.reason}\n`
      );
      continue;
    }
    const hash = sha1(Buffer.from(result.rawStdout));
    for (const ev of eventsForSid) {
      corrections.set(`${ev.session_id}||${ev.ts}`, {
        ...ev,
        task: result.task,
        task_source: 'recap',
        task_recap_hash: hash
      });
      updated++;
    }
  }

  const estCostUsd = eligibleSids.length * PER_RECAP_COST_ESTIMATE_USD;
  return { corrections, updated, skipped, estCostUsd, costCeilingHit };
}

/**
 * --apply-recaps execution flow per spec §6.1.
 * Filters weak-task candidates, calls `claude --print --resume <sid>` per
 * event, and writes via the shared race-guarded atomic write.
 */
async function runApplyRecaps(args, ctx) {
  const candidates = selectRecapCandidates(ctx.events, args);

  if (ctx.isDryRun) {
    printRecapDryRun(candidates);
    return;
  }

  const maxCost = Number.isFinite(args.maxCost) ? args.maxCost : DEFAULT_MAX_COST_USD;
  const model = args.recapModel || DEFAULT_RECAP_MODEL;
  const concurrency = Number.isInteger(args.concurrency) ? args.concurrency : DEFAULT_CONCURRENCY;
  process.stdout.write(`Recap model: ${model} (concurrency: ${concurrency})\n`);
  const { corrections, updated, skipped, estCostUsd } =
    await buildRecapCorrectionsAsync(candidates, maxCost, model, concurrency);

  if (corrections.size === 0) {
    process.stdout.write(
      `No corrections to apply. Updated=0 Skipped=${skipped} Cost~$${estCostUsd.toFixed(2)}\n`
    );
    return;
  }

  await writeCorrections(corrections, ctx);
  process.stdout.write(
    `Applied. Updated=${updated} Skipped=${skipped} Estimated cost ~$${estCostUsd.toFixed(2)}\n`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  if (args.apply && !args.fill && !args.reconcile && !args.applyRecaps) {
    process.stderr.write(
      '--apply requires --fill, --reconcile, or --apply-recaps\n\n' + USAGE + '\n'
    );
    process.exit(1);
  }
  if (args.applyRecaps && args.audit) {
    process.stderr.write('--apply-recaps cannot combine with --audit\n');
    process.exit(1);
  }

  const rootDir = path.join(__dirname, '..');
  const eventsFile = args.eventsFile ||
    path.join(rootDir, '.ai-memory', 'session-end-events.jsonl');
  const transcriptDir = args.transcriptDir ||
    path.join(os.homedir(), '.claude', 'projects', rootDir.replace(/[/\\]/g, '-'));

  if (!fs.existsSync(eventsFile)) {
    process.stderr.write(`ERROR: no events file at ${eventsFile}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(transcriptDir)) {
    process.stderr.write(`ERROR: transcript dir not found: ${transcriptDir}\n`);
    process.exit(1);
  }

  const rawContent = await fsp.readFile(eventsFile, 'utf8');
  const originalHash = sha1(rawContent);
  const events = parseSessionEndRows(rawContent);

  if (args.applyRecaps) {
    await runApplyRecaps(args, {
      eventsFile, rawContent, originalHash, events,
      isDryRun: !args.apply
    });
    return;
  }

  const sessionMap = await buildSessionMap(events, transcriptDir);
  const classified = classifyAll(events, sessionMap);

  const inScope = args.session
    ? classified.filter(c => c.ev.session_id === args.session)
    : classified;
  const counts = tallyCounts(inScope);

  const writeMode = args.fill ? 'fill' : (args.reconcile ? 'reconcile' : null);
  const actionable = new Set();
  if (writeMode === 'fill') actionable.add('empty_fillable');
  if (writeMode === 'reconcile') {
    actionable.add('empty_fillable');
    actionable.add('sidecar_leak');
    actionable.add('mid_session_drift');
  }

  const isDryRun = !args.apply;
  const categoriesToShow = args.audit
    ? ['empty_fillable', 'sidecar_leak', 'mid_session_drift']
    : [...actionable];

  if (args.audit || isDryRun) printAuditReport(counts, inScope, { categoriesToShow });

  if (isDryRun && writeMode) {
    const wouldChange = inScope.filter(c => actionable.has(c.category)).length;
    process.stdout.write(`Would change ${wouldChange} rows. Re-run with --apply to write.\n`);
    return;
  }
  if (args.audit && !writeMode) {
    process.stdout.write(`Re-run with --fill or --reconcile --apply to write corrections.\n`);
    return;
  }

  if (writeMode && args.apply) {
    await applyWrites(inScope, writeMode, actionable, { eventsFile, rawContent, originalHash });
  }
}

main().catch(err => {
  process.stderr.write(`Unexpected error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
