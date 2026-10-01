'use strict';

// backfill-task-from-transcripts.js
//
// Fill empty task / jira_ticket on past .ai-memory/session-end-events.jsonl
// entries by re-running the same transcript heuristic that session-stop uses
// for live events:
//   - task: longest of the first 5 substantive user prompts (string content,
//           non-meta, non-command, > 10 chars), whitespace-normalized,
//           140-char cap, secret-shaped tokens dropped.
//   - jira_ticket: first $JIRA_PREFIX-NNN match in any user prompt.
//
// Sidecar values and existing non-empty fields always win — only empties are
// filled.
//
// LIMITATION: Only events whose transcripts live on THIS machine can be
// backfilled. Teammate events stay untouched.
//
// Modes:
//   --audit (default) — show candidates, no writes
//   --apply           — backup + rewrite events file in place
//
// Env knobs:
//   EVENTS_FILE_OVERRIDE      — point at fixture (used by tests)
//   TRANSCRIPT_DIR_OVERRIDE   — override ~/.claude/projects/<flat-cwd>/

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readTranscript } = require('./_lib/transcript');
const { extractTask, extractJiraTicket, looksLikeSecret } = require('./_lib/heuristics');
const { atomicWrite } = require('./_lib/process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAMPLE_LIMIT = 5;

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const EVENTS_FILE = process.env.EVENTS_FILE_OVERRIDE
  || path.join(ROOT_DIR, '.ai-memory', 'session-end-events.jsonl');
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR_OVERRIDE
  || path.join(os.homedir(), '.claude', 'projects', ROOT_DIR.replace(/[\\/]/g, '-'));

function parseMode(argv) {
  const a = argv[2];
  if (a === undefined || a === '--audit') return 'audit';
  if (a === '--apply') return 'apply';
  process.stderr.write(`usage: ${path.basename(__filename)} [--audit|--apply]\n`);
  process.exit(1);
  return null;
}

async function deriveForSession(sid) {
  const transcriptPath = path.join(TRANSCRIPT_DIR, `${sid}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return { hasTranscript: false, task: '', jira: '' };
  const { userPrompts } = await readTranscript(transcriptPath);
  let task = extractTask(userPrompts);
  if (looksLikeSecret(task)) task = '';
  const jira = extractJiraTicket(userPrompts);
  return { hasTranscript: true, task, jira };
}

async function main() {
  const mode = parseMode(process.argv);

  if (!fs.existsSync(EVENTS_FILE)) {
    process.stderr.write(`no events file at ${EVENTS_FILE}\n`);
    process.exit(0);
  }
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    process.stderr.write(`transcript dir not found: ${TRANSCRIPT_DIR}\n`);
    process.stderr.write(`(this is normal on machines that haven't run CC against this workspace)\n`);
    process.exit(0);
  }

  const rawContent = fs.readFileSync(EVENTS_FILE, 'utf8');
  const originalLines = rawContent.split('\n');

  // Phase 1: collect candidate session_ids (session_end with empty task OR jira)
  const candidateSids = new Set();
  for (const line of originalLines) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'session_end') continue;
    const sid = ev.session_id || '';
    if (!sid || !UUID_RE.test(sid)) continue;
    const taskEmpty = (ev.task || '') === '';
    const jiraEmpty = (ev.jira_ticket || '') === '';
    if (taskEmpty || jiraEmpty) candidateSids.add(sid);
  }

  // Phase 2: derive from transcripts
  const lookup = new Map();
  let noTranscript = 0;
  let noSignal = 0;
  let extracted = 0;

  for (const sid of candidateSids) {
    const { hasTranscript, task, jira } = await deriveForSession(sid);
    if (!hasTranscript) { noTranscript++; continue; }
    if (!task && !jira) { noSignal++; continue; }
    lookup.set(sid, { task, jira });
    extracted++;
  }

  const total = candidateSids.size;
  process.stdout.write(`Sessions with empty task or jira:    ${total}\n`);
  process.stdout.write(`Transcripts on disk:                 ${total - noTranscript}\n`);
  process.stdout.write(`  no transcript on disk (skipped):   ${noTranscript}\n`);
  process.stdout.write(`  transcript yielded no signal:      ${noSignal}\n`);
  process.stdout.write(`  extractable (task and/or jira):    ${extracted}\n`);

  if (mode === 'audit') {
    process.stdout.write('\n=== sample candidates (first 5) ===\n');
    let shown = 0;
    for (const [sid, { task, jira }] of lookup) {
      if (shown >= SAMPLE_LIMIT) break;
      const taskShort = (task || '').slice(0, 80);
      process.stdout.write(`  ${sid.slice(0, 8)} | jira=${jira || '-'} | task=${taskShort}\n`);
      shown++;
    }
    process.stdout.write('\nRe-run with --apply to write.\n');
    return;
  }

  if (lookup.size === 0) {
    process.stdout.write('Nothing to apply.\n');
    return;
  }

  // Phase 3: rewrite. Mutate parsed JSON only for empty fields.
  const newLines = originalLines.map(line => {
    if (!line) return line;
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }
    if (ev.type !== 'session_end') return line;
    const hit = lookup.get(ev.session_id);
    if (!hit) return line;
    const updated = { ...ev };
    if ((updated.task || '') === '' && hit.task) updated.task = hit.task;
    if ((updated.jira_ticket || '') === '' && hit.jira) updated.jira_ticket = hit.jira;
    return JSON.stringify(updated);
  });

  if (newLines.length !== originalLines.length) {
    throw new Error(
      `line count changed (${originalLines.length} -> ${newLines.length}), events file untouched`
    );
  }

  const backupPath = `${EVENTS_FILE}.bak.${Date.now()}`;
  fs.copyFileSync(EVENTS_FILE, backupPath);
  process.stdout.write(`Backup: ${backupPath}\n`);

  const newContent = newLines.join('\n');
  await atomicWrite(EVENTS_FILE, newContent);

  const written = newLines.filter(l => l.length > 0).length;
  process.stdout.write(`Applied. Events filled. Total events: ${written}\n`);
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
