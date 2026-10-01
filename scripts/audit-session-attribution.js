'use strict';

// audit-session-attribution.js
//
// Read-only audit of `.ai-memory/session-end-events.jsonl`. Reports
// cross-terminal attribution drift in the token dashboard's source data.
//
// Three checks:
//   1. EMPTY-SID    Events with no session_id — unattributable on the dashboard.
//   2. SPLIT-ATTR   Same session_id with multiple distinct jira_ticket OR
//                   project values (likely cross-terminal contamination).
//   3. SIDECAR-DRIFT Last event's project/jira_ticket disagrees with the
//                   sidecar at .ai-session/by-id/<sid>.json.
//
// Default output is human-readable; `--json` emits a machine-readable report.
// Exit 0 always (read-only).
//
// Distinct from `reconcile-session-events.js`, which fills/corrects task and
// jira fields from CC transcripts. This script only audits and reports.

const fs = require('node:fs');
const path = require('node:path');
const { readAllLines } = require('./_lib/session-events');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);
// A single-file override (tests) takes precedence; otherwise union the legacy
// archive + every monthly shard (scripts/_lib/session-events.js).
const EVENTS_FILE_OVERRIDE = process.env.EVENTS_FILE_OVERRIDE || '';
const SIDECAR_DIR = process.env.SIDECAR_DIR_OVERRIDE
  || path.join(ROOT_DIR, '.ai-session', 'by-id');

const emitJson = process.argv[2] === '--json';

let lines;
if (EVENTS_FILE_OVERRIDE) {
  if (!fs.existsSync(EVENTS_FILE_OVERRIDE)) {
    process.stderr.write(`audit: no events file at ${EVENTS_FILE_OVERRIDE} — nothing to audit\n`);
    process.exit(0);
  }
  lines = fs.readFileSync(EVENTS_FILE_OVERRIDE, 'utf8').split('\n').filter(l => l.length > 0);
} else {
  lines = readAllLines(ROOT_DIR);
  if (lines.length === 0) {
    process.stderr.write('audit: no session events found — nothing to audit\n');
    process.exit(0);
  }
}

let total = 0;
let emptySid = 0;
let reconciled = 0;
const bySession = new Map();

for (const line of lines) {
  total++;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  const sid = ev.session_id ?? '';
  if (sid === '') { emptySid++; continue; }
  if (ev.attribution_review_needed === true) reconciled++;
  let entry = bySession.get(sid);
  if (!entry) {
    entry = { tickets: new Set(), projects: new Set(), events: 0, lastEvent: null, lastTs: '' };
    bySession.set(sid, entry);
  }
  entry.events++;
  const jt = ev.jira_ticket ?? '';
  const pj = ev.project ?? '';
  if (jt) entry.tickets.add(jt);
  if (pj) entry.projects.add(pj);
  const ts = ev.ts ?? '';
  if (ts >= entry.lastTs) {
    entry.lastTs = ts;
    entry.lastEvent = { project: pj, jira_ticket: jt };
  }
}

const splitSessions = [];
for (const [sid, e] of bySession) {
  if (e.tickets.size > 1 || e.projects.size > 1) {
    splitSessions.push({
      sid,
      tickets: [...e.tickets],
      projects: [...e.projects],
      events: e.events,
    });
  }
}

const driftSessions = [];
const sidecarDirExists = fs.existsSync(SIDECAR_DIR) && fs.statSync(SIDECAR_DIR).isDirectory();
if (sidecarDirExists) {
  for (const [sid, e] of bySession) {
    if (!UUID_RE.test(sid)) continue;
    const scPath = path.join(SIDECAR_DIR, `${sid}.json`);
    if (!fs.existsSync(scPath)) continue;
    let sc;
    try { sc = JSON.parse(fs.readFileSync(scPath, 'utf8')); } catch { continue; }
    const evP = e.lastEvent.project ?? '';
    const evJ = e.lastEvent.jira_ticket ?? '';
    const scP = sc.project ?? '';
    const scJ = sc.jira_ticket ?? '';
    const projDrift = evP && scP && evP !== scP;
    const jiraDrift = evJ && scJ && evJ !== scJ;
    if (projDrift || jiraDrift) {
      driftSessions.push({
        sid, ev_project: evP, sc_project: scP, ev_jira: evJ, sc_jira: scJ,
      });
    }
  }
}

if (emitJson) {
  process.stdout.write(JSON.stringify({
    events_total: total,
    empty_session_id: emptySid,
    split_attribution: { count: splitSessions.length, sessions: splitSessions },
    reconciled_events: reconciled,
    sidecar_drift: { count: driftSessions.length, sessions: driftSessions },
  }) + '\n');
  process.exit(0);
}

const out = [];
out.push('session-end-events.jsonl audit');
out.push('──────────────────────────────');
out.push(`  events scanned        ${total}`);
out.push(`  empty session_id      ${emptySid}  (unattributed on dashboard)`);
out.push(`  split-attribution     ${splitSessions.length}  (same session_id seen with multiple tickets/projects)`);
out.push(`  reconciled events     ${reconciled}  (already flagged via reconcile-session-attribution.sh)`);
out.push(`  sidecar drift         ${driftSessions.length}  (last event disagrees with current sidecar)`);
out.push('');

if (splitSessions.length > 0) {
  out.push('split-attribution sessions (likely cross-terminal contamination):');
  for (const s of splitSessions) {
    out.push(`  ${s.sid}   tickets=${s.tickets.join(',')}   projects=${s.projects.join(',')}   events=${s.events}`);
  }
  out.push('');
}

if (driftSessions.length > 0) {
  out.push('sidecar drift (event vs current sidecar):');
  for (const d of driftSessions) {
    out.push(`  ${d.sid}   event=[${d.ev_project}/${d.ev_jira}]   sidecar=[${d.sc_project}/${d.sc_jira}]`);
  }
  out.push('');
}

if (emptySid === 0 && splitSessions.length === 0 && driftSessions.length === 0) {
  out.push('✓ no attribution drift detected');
}

process.stdout.write(out.join('\n') + '\n');
process.exit(0);
