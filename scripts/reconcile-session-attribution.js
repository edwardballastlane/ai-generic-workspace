'use strict';

// reconcile-session-attribution.js
//
// Repairs cross-terminal attribution drift in
// .ai-memory/session-end-events.jsonl by ANNOTATING events with review flags.
// Two signals classify a session_end event as suspect:
//
//   1. Split session — same session_id seen with multiple distinct
//      jira_ticket OR project values across events. Winning ticket comes
//      from the CC transcript when present (ground truth), else majority
//      vote among the session's events.
//
//   2. Task-jira mismatch — jira_ticket holds a [A-Z]+-[0-9]+ token but the
//      task text does not name that ticket; strong sign the ticket leaked
//      in from the ambient git branch while the user did unrelated work.
//
// Suspect events gain attribution_review_needed=true plus method/primary
// fields. Original `jira_ticket`, `project`, and `task` are LEFT UNTOUCHED
// so the dashboard's leg-aware aggregation still works and a reviewer can
// compare.
//
// Modes:
//   --audit   (default) write a report to stdout; do not modify the file
//   --apply             back up the events file, then rewrite annotated
//
// SCOPE — distinct from `reconcile-session-events.js` (Phase 2):
//   * reconcile-session-events.js: fills/corrects `task` and `jira_ticket`
//     from CC transcripts. Writes the canonical fields directly.
//   * reconcile-session-attribution.js (this file): ONLY annotates events
//     with `attribution_review_needed`. NEVER overwrites `task`, `project`,
//     or `jira_ticket`.
//
// Env knobs:
//   EVENTS_FILE_OVERRIDE     - point at fixture (used by tests)
//   CC_PROJECTS_OVERRIDE     - override ~/.claude/projects/

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { readTranscript } = require('./_lib/transcript');
const { atomicWrite } = require('./_lib/process');

// Local broad pattern preserves the bash semantics
// (`grep -oE '[A-Z]+-[0-9]+'`). MUST stay local - the heuristics module's
// extractJiraTicket is JIRA_PREFIX-driven and matches nothing when that is
// unset, which is the wrong behaviour for an audit that has to read whatever
// ticket keys the repo history actually contains.
const BROAD_JIRA_RE = /\b[A-Z]+-[0-9]+\b/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const EVENTS_FILE = process.env.EVENTS_FILE_OVERRIDE
  || path.join(ROOT_DIR, '.ai-memory', 'session-end-events.jsonl');
const CC_PROJECTS = process.env.CC_PROJECTS_OVERRIDE
  || path.join(os.homedir(), '.claude', 'projects');

function parseMode(argv) {
  const a = argv[2];
  if (a === undefined || a === '--audit') return 'audit';
  if (a === '--apply') return 'apply';
  process.stderr.write(`usage: ${path.basename(__filename)} [--audit|--apply]\n`);
  process.exit(1);
  return null;
}

/**
 * Locate the CC transcript path for a given session_id.
 * Replaces `find $CC_PROJECTS -maxdepth 2 -name <sid>.jsonl -print -quit`.
 */
function findTranscript(ccProjects, sid) {
  if (!UUID_RE.test(sid)) return null;
  let entries;
  try {
    entries = fs.readdirSync(ccProjects);
  } catch {
    return null;
  }
  for (const slug of entries) {
    const p = path.join(ccProjects, slug, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Extract sorted-unique [A-Z]+-[0-9]+ tokens from the user prompts of a
 * transcript. Empty array on missing transcript or no matches.
 */
async function extractTranscriptTickets(transcriptPath) {
  if (!transcriptPath) return [];
  const { userPrompts } = await readTranscript(transcriptPath);
  const found = new Set();
  for (const prompt of userPrompts) {
    const matches = String(prompt).match(BROAD_JIRA_RE);
    if (matches) for (const m of matches) found.add(m);
  }
  return [...found].sort();
}

/**
 * Pick the most-frequent non-empty value in an array. Returns '' if no
 * non-empty values. Ties resolve by first-seen (stable Map ordering).
 */
function majorityValue(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let winner = '';
  let maxCount = 0;
  for (const [v, c] of counts) {
    if (c > maxCount) { winner = v; maxCount = c; }
  }
  return winner;
}

/**
 * For a session's events plus the (possibly empty) transcript ticket list,
 * return { primaryJira, method }. Method is 'transcript' when any event's
 * jira_ticket appears in the transcript tickets, else 'majority'.
 */
function pickPrimaryJira(sessionEvents, transcriptTickets) {
  if (transcriptTickets.length > 0) {
    const transcriptSet = new Set(transcriptTickets);
    const eventTickets = [...new Set(
      sessionEvents.map(e => e.jira_ticket || '').filter(t => t)
    )].sort();
    const hit = eventTickets.find(t => transcriptSet.has(t));
    if (hit) return { primaryJira: hit, method: 'transcript' };
  }
  const maj = majorityValue(sessionEvents.map(e => e.jira_ticket || ''));
  return { primaryJira: maj, method: 'majority' };
}

/**
 * Pick the majority project for a session. Computed independently of jira
 * so the project axis stays accurate when jira is missing.
 */
function pickPrimaryProject(sessionEvents) {
  return majorityValue(sessionEvents.map(e => e.project || ''));
}

/**
 * Group parsed events by session_id, retaining the original line index.
 */
function groupBySession(parsedRows) {
  const bySid = new Map();
  for (const { line, event } of parsedRows) {
    const sid = event.session_id || '';
    if (!sid) continue;
    let bucket = bySid.get(sid);
    if (!bucket) { bucket = []; bySid.set(sid, bucket); }
    bucket.push({ line, event });
  }
  return bySid;
}

/**
 * Identify split sessions: > 1 distinct non-empty jira_ticket OR project.
 */
function findSplitSessions(bySid) {
  const split = [];
  for (const [sid, rows] of bySid) {
    const tickets = new Set();
    const projects = new Set();
    for (const { event } of rows) {
      if (event.jira_ticket) tickets.add(event.jira_ticket);
      if (event.project) projects.add(event.project);
    }
    if (tickets.size > 1 || projects.size > 1) {
      split.push({ sid, rows });
    }
  }
  return split;
}

/**
 * Classify each event in a split session against the chosen primary
 * (jira, project). Returns array of classification records.
 */
function classifySplitSession(sid, rows, transcriptTickets) {
  const sessionEvents = rows.map(r => r.event);
  const { primaryJira, method } = pickPrimaryJira(sessionEvents, transcriptTickets);
  const primaryProject = pickPrimaryProject(sessionEvents);
  const records = [];
  for (const { line, event } of rows) {
    const evJira = event.jira_ticket || '';
    const evProject = event.project || '';
    let suspect = false;
    if (primaryJira && evJira && evJira !== primaryJira) suspect = true;
    if (primaryProject && evProject && evProject !== primaryProject) suspect = true;
    records.push({
      line, sid, method,
      primary_jira: primaryJira,
      primary_project: primaryProject,
      suspect,
    });
  }
  return records;
}

/**
 * Find task-jira mismatches: jira_ticket matches BROAD_JIRA_RE but the
 * task text does NOT contain the extracted ticket. Returns one record per
 * mismatch.
 */
function findTaskJiraMismatches(parsedRows) {
  const out = [];
  for (const { line, event } of parsedRows) {
    const jira = event.jira_ticket || '';
    const task = event.task || '';
    if (!jira || !task) continue;
    BROAD_JIRA_RE.lastIndex = 0;
    const m = BROAD_JIRA_RE.exec(jira);
    if (!m) continue;
    const ticket = m[0];
    if (task.includes(ticket)) continue;
    out.push({
      line,
      sid: event.session_id || '',
      method: 'task_jira_mismatch',
      primary_jira: '',
      primary_project: event.project || '',
      suspect: true,
    });
  }
  return out;
}

/**
 * Build classification list across both detectors. Split-session results
 * win when the same line is also flagged as task-jira mismatch.
 */
async function classifyAll(parsedRows, ccProjects) {
  const bySid = groupBySession(parsedRows);
  const splitSessions = findSplitSessions(bySid);

  const classifications = [];
  for (const { sid, rows } of splitSessions) {
    const tpath = findTranscript(ccProjects, sid);
    const transcriptTickets = await extractTranscriptTickets(tpath);
    classifications.push(...classifySplitSession(sid, rows, transcriptTickets));
  }

  const splitLines = new Set(classifications.map(c => c.line));
  const mismatches = findTaskJiraMismatches(parsedRows);
  for (const m of mismatches) {
    if (!splitLines.has(m.line)) classifications.push(m);
  }
  return classifications;
}

/**
 * Print the per-session audit report.
 */
function printAuditReport(classifications) {
  const suspectCount = classifications.filter(c => c.suspect).length;
  const total = classifications.length;
  const taskMismatchCount = classifications.filter(c => c.method === 'task_jira_mismatch').length;
  const splitSuspect = suspectCount - taskMismatchCount;
  const sessions = new Set(classifications.map(c => c.sid));

  process.stdout.write('session attribution reconciliation - DRY RUN\n');
  process.stdout.write('---------------------------------------------\n');
  process.stdout.write(`  sessions to touch    ${sessions.size}\n`);
  process.stdout.write(`  events classified    ${total}\n`);
  process.stdout.write(`  events flagged       ${suspectCount}  (would gain attribution_review_needed=true)\n`);
  process.stdout.write(`    via split detect   ${splitSuspect}  (session has multiple jiras/projects)\n`);
  process.stdout.write(`    via task mismatch  ${taskMismatchCount}  (jira_ticket set, but task does not name it)\n`);
  process.stdout.write('\n');
  process.stdout.write('per-session breakdown (method=transcript means we found the CC transcript):\n');

  const bySid = new Map();
  for (const c of classifications) {
    let bucket = bySid.get(c.sid);
    if (!bucket) {
      bucket = {
        sid: c.sid,
        method: c.method,
        primary_jira: c.primary_jira,
        primary_project: c.primary_project,
        events: 0,
        suspect_events: 0,
      };
      bySid.set(c.sid, bucket);
    }
    bucket.events++;
    if (c.suspect) bucket.suspect_events++;
  }
  for (const b of bySid.values()) {
    process.stdout.write(
      `  ${b.sid}   method=${b.method}` +
      `   primary=[${b.primary_project}/${b.primary_jira}]` +
      `   events=${b.events}` +
      `   flagged=${b.suspect_events}\n`
    );
  }
  process.stdout.write('\n');
  process.stdout.write(`to apply: node ${path.basename(__filename)} --apply\n`);
  process.stdout.write('(events file will be backed up alongside as .bak before any write)\n');
}

/**
 * Apply mode: backup, then rewrite events with annotations on suspect lines.
 */
async function applyAnnotations(originalLines, classifications) {
  const lookup = new Map();
  for (const c of classifications) {
    if (!c.suspect) continue;
    lookup.set(c.line, {
      method: c.method,
      primary_jira: c.primary_jira,
      primary_project: c.primary_project,
    });
  }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backupPath = `${EVENTS_FILE}.bak.${ts}`;
  await fsp.copyFile(EVENTS_FILE, backupPath);
  process.stdout.write(`backup written to ${backupPath}\n`);

  let annotated = 0;
  const newLines = originalLines.map((line, idx) => {
    if (!line) return line;
    const ann = lookup.get(idx + 1);
    if (!ann) return line;
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }
    if (
      ev.attribution_review_needed === true &&
      ev.attribution_method === ann.method &&
      ev.primary_jira_ticket === ann.primary_jira &&
      ev.primary_project === ann.primary_project
    ) {
      return line;
    }
    const updated = {
      ...ev,
      attribution_review_needed: true,
      attribution_method: ann.method,
      primary_jira_ticket: ann.primary_jira,
      primary_project: ann.primary_project,
    };
    annotated++;
    return JSON.stringify(updated);
  });

  if (newLines.length !== originalLines.length) {
    throw new Error(
      `line count changed (${originalLines.length} -> ${newLines.length}), events file untouched`
    );
  }

  const newContent = newLines.join('\n');
  await atomicWrite(EVENTS_FILE, newContent);

  const suspectCount = classifications.filter(c => c.suspect).length;
  process.stdout.write(
    `rewrote ${EVENTS_FILE} - ${suspectCount} suspect events identified, ${annotated} annotated (skips already-current rows)\n`
  );
  process.stdout.write(`review with: grep '"attribution_review_needed":true' ${EVENTS_FILE} | head\n`);
  process.stdout.write(`rollback with: cp ${backupPath} ${EVENTS_FILE}\n`);
}

async function main() {
  const mode = parseMode(process.argv);

  if (!fs.existsSync(EVENTS_FILE)) {
    process.stderr.write(`no events file at ${EVENTS_FILE}\n`);
    process.exit(0);
  }

  const rawContent = await fsp.readFile(EVENTS_FILE, 'utf8');
  const originalLines = rawContent.split('\n');

  const parsedRows = [];
  originalLines.forEach((line, idx) => {
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    parsedRows.push({ line: idx + 1, event: ev });
  });

  const classifications = await classifyAll(parsedRows, CC_PROJECTS);

  if (classifications.length === 0) {
    process.stdout.write('no split-attribution and no task-jira mismatch — nothing to reconcile\n');
    process.exit(0);
  }

  if (mode === 'audit') {
    printAuditReport(classifications);
    return;
  }

  await applyAnnotations(originalLines, classifications);
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
