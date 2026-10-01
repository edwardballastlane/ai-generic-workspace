'use strict';

// backfill-jira-from-commits.js
//
// Back-fill jira_ticket attribution on .ai-memory/session-end-events.jsonl
// events that currently have no ticket OR were reconciled-to-empty by
// reconcile-session-attribution, using the local git repos under
// agent/_projects/<*> as ground truth.
//
// Algorithm (per event):
//   1. Skip events that already carry a real jira_ticket.
//   2. Resolve the event's user to a git author email by walking commit
//      history once at startup (workspace events file + every project repo).
//   3. Scan every git repo under agent/_projects/ for commits authored by
//      that user within ±WINDOW_HOURS of the event timestamp.
//   4. Collect [A-Z]+-[0-9]+ patterns from commit subjects (these surface
//      the working branch name via "Merged in feat/KEY-NNNNN" subjects, and
//      conventional-commits prefixes like "feat(KEY-NNNNN): ...").
//   5. Pick the dominant ticket; tied plurality → AMBIGUOUS skip.
//
// Modes:
//   --audit (default) — print candidate back-fills, no writes
//   --apply           — back up events file, then rewrite annotations
//
// Tunables (env, with defaults):
//   WINDOW_HOURS=2                 — ±N hours around event timestamp
//   COMMIT_STRENGTH_OVERRIDE=3     — ≥N commits to override task_jira_mismatch / multi-ticket plurality
//   PROJECTS_DIR_OVERRIDE=...      — git repos to scan (default: agent/_projects/)
//   EVENTS_FILE_OVERRIDE=...       — point at a fixture (used by tests)
//   USER_FILTER=...                — restrict audit output to one user (display only)
//
// Note: BROAD_JIRA_RE is local to this file (broad [A-Z]+-[0-9]+). The shared
// heuristics.extractJiraTicket is narrowed to $JIRA_PREFIX on purpose; this scan
// has to read whatever ticket keys the history contains, so it stays broad.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { atomicWrite } = require('./_lib/process');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const EVENTS_FILE = process.env.EVENTS_FILE_OVERRIDE
  || path.join(ROOT_DIR, '.ai-memory', 'session-end-events.jsonl');
const PROJECTS_DIR = process.env.PROJECTS_DIR_OVERRIDE
  || path.join(ROOT_DIR, 'agent', '_projects');
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? '2');
const COMMIT_STRENGTH_OVERRIDE = Number(process.env.COMMIT_STRENGTH_OVERRIDE ?? '3');
const USER_FILTER = process.env.USER_FILTER ?? '';

const BROAD_JIRA_RE = /\b[A-Z]+-[0-9]+\b/g;
const REAL_TICKET_RE = /[A-Z]+-[0-9]+/;

// ── Arg parsing ──────────────────────────────────────────────────
const arg = process.argv[2];
let mode = 'audit';
if (arg === '--apply') mode = 'apply';
else if (arg === '--audit' || arg === undefined || arg === '') mode = 'audit';
else {
  process.stderr.write(`usage: ${process.argv[1]} [--audit|--apply]\n`);
  process.exit(1);
}

if (!fs.existsSync(EVENTS_FILE)) {
  process.stderr.write(`no events file at ${EVENTS_FILE}\n`);
  process.exit(0);
}

// ── User → email mapping ─────────────────────────────────────────
function gitLogPairs(repo, pathSpec) {
  const args = ['log', '--pretty=format:%an|%ae'];
  if (pathSpec) {
    args.push('--', pathSpec);
  } else {
    args.push('--all');
  }
  try {
    const out = execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function listProjectRepos() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const repos = [];
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    // Follow symlinks: agent/_projects/* are typically symlinks per CLAUDE.md.
    let isDir = ent.isDirectory();
    const full = path.join(PROJECTS_DIR, ent.name);
    if (!isDir && ent.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;
    if (!isGitRepo(full)) continue;
    repos.push(full);
  }
  return repos;
}

// Build Map<lowerFirstName, Set<email>> once at startup. Two phases:
//   1. Workspace git log filtered to .ai-memory/session-end-events.jsonl
//      (these are the engineers' commit identities for the events file).
//   2. Each project repo's full --all log.
function buildUserEmailMap(repos) {
  const pairsRaw = [];
  // Phase 1: workspace events-file authorship
  pairsRaw.push(...gitLogPairs(ROOT_DIR, '.ai-memory/session-end-events.jsonl'));
  // Phase 2: per-project repos
  for (const repo of repos) {
    pairsRaw.push(...gitLogPairs(repo));
  }
  // Deduplicate "name|email" pairs, then bucket by lowercase first name token.
  const seen = new Set();
  const map = new Map();
  for (const pair of pairsRaw) {
    if (seen.has(pair)) continue;
    seen.add(pair);
    const idx = pair.indexOf('|');
    if (idx <= 0 || idx === pair.length - 1) continue;
    const name = pair.slice(0, idx).trim();
    const email = pair.slice(idx + 1).trim();
    if (!name || !email) continue;
    const firstToken = name.toLowerCase().split(/\s+/)[0];
    if (!firstToken) continue;
    let bucket = map.get(firstToken);
    if (!bucket) { bucket = new Set(); map.set(firstToken, bucket); }
    bucket.add(email);
  }
  return map;
}

function emailsForUser(userEmailMap, user) {
  const first = String(user || '').toLowerCase().split(/\s+/)[0];
  if (!first) return [];
  // Match: first token of stored name === first token of user, OR
  //        stored bucket-key contains user as substring (case-insensitive).
  // The bash version also did substring match on the full lowered name; we
  // only have the first-token bucket here, but bash's `index(lname, u) > 0`
  // is a substring search on the full name — replicate by ALSO scanning all
  // buckets and matching when bucket-key contains `first`.
  const out = new Set();
  const exact = userEmailMap.get(first);
  if (exact) for (const e of exact) out.add(e);
  for (const [key, emails] of userEmailMap) {
    if (key === first) continue;
    if (key.includes(first) || first.includes(key)) {
      for (const e of emails) out.add(e);
    }
  }
  return [...out];
}

// ── Ticket window ───────────────────────────────────────────────
function ticketsInWindow(emails, repos, ts) {
  const ep = new Date(ts).getTime();
  if (!Number.isFinite(ep)) return [];
  const deltaMs = WINDOW_HOURS * 3_600_000;
  const from = new Date(ep - deltaMs).toISOString();
  const to = new Date(ep + deltaMs).toISOString();
  const tickets = [];
  for (const email of emails) {
    if (!email) continue;
    for (const repo of repos) {
      let stdout;
      try {
        stdout = execFileSync('git', [
          'log', '--all',
          `--author=${email}`,
          '--pretty=format:%s',
          `--since=${from}`,
          `--until=${to}`,
        ], {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch {
        continue;
      }
      const subjects = stdout.split('\n').filter(Boolean);
      for (const subject of subjects) {
        const matches = subject.match(BROAD_JIRA_RE);
        if (matches) tickets.push(...matches);
      }
    }
  }
  return tickets;
}

function dominantTicket(ticketLines) {
  const counts = new Map();
  for (const t of ticketLines) counts.set(t, (counts.get(t) || 0) + 1);
  let maxCount = 0, winner = null, ties = 0;
  for (const [t, c] of counts) {
    if (c > maxCount) { maxCount = c; winner = t; ties = 1; }
    else if (c === maxCount) { ties++; }
  }
  return ties === 1 && winner ? { ticket: winner, count: maxCount } : null;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const repos = listProjectRepos();
  if (repos.length === 0) {
    process.stderr.write(`no git repos under ${PROJECTS_DIR}\n`);
    process.exit(0);
  }

  const userEmailMap = buildUserEmailMap(repos);

  const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  const lines = raw.split('\n');
  // Preserve original line count for assertion. Track which lines correspond
  // to events we may rewrite (we keep blank trailing line(s) untouched).
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { events.push({ lineNo: i, raw: line, ev: null }); continue; }
    let ev;
    try { ev = JSON.parse(line); }
    catch { events.push({ lineNo: i, raw: line, ev: null }); continue; }
    events.push({ lineNo: i, raw: line, ev });
  }

  let scanned = 0;
  let qualified = 0;
  let single = 0;
  let ambiguous = 0;
  let none = 0;
  const candidates = [];

  for (const entry of events) {
    if (!entry.ev) continue;
    scanned++;
    const ev = entry.ev;
    const sid = ev.session_id ?? '';
    const ts = ev.ts ?? '';
    const user = ev.user ?? '';
    const jira = ev.jira_ticket ?? '';
    const primary = ev.primary_jira_ticket ?? '';
    const method = ev.attribution_method ?? '';
    const project = ev.project ?? '';

    if (!sid || !ts || !user) continue;
    if (REAL_TICKET_RE.test(jira)) continue;
    if (primary) continue;

    const emails = emailsForUser(userEmailMap, user);
    if (emails.length === 0) continue;
    qualified++;

    const hits = ticketsInWindow(emails, repos, ts);
    if (hits.length === 0) { none++; continue; }
    const uniqueTickets = new Set(hits).size;
    if (uniqueTickets === 0) { none++; continue; }

    const dom = dominantTicket(hits);
    if (!dom) { ambiguous++; continue; }
    const ticket = dom.ticket;
    const ticketCount = dom.count;

    if (method === 'task_jira_mismatch') {
      if (ticketCount < COMMIT_STRENGTH_OVERRIDE) continue;
    }
    if (uniqueTickets > 1 && ticketCount < COMMIT_STRENGTH_OVERRIDE) {
      ambiguous++;
      continue;
    }

    single++;
    candidates.push({
      lineNo: entry.lineNo,
      sid,
      user,
      ts,
      ticket,
      project,
    });
  }

  if (mode === 'audit') {
    printAudit({ scanned, qualified, single, ambiguous, none, repos, candidates });
    process.exit(0);
  }

  // Apply mode
  if (single === 0) {
    process.stdout.write('no back-fillable events; nothing to write\n');
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.[0-9]+Z$/, 'Z');
  const backup = `${EVENTS_FILE}.bak.${stamp}`;
  try {
    fs.copyFileSync(EVENTS_FILE, backup);
  } catch (err) {
    process.stderr.write(`backup failed; aborting: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`backup written to ${backup}\n`);

  const candidateByLine = new Map();
  for (const c of candidates) candidateByLine.set(c.lineNo, c);

  const newLines = lines.map((line, idx) => {
    const c = candidateByLine.get(idx);
    if (!c) return line;
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }
    // Idempotency: skip rewrite when annotations already present and equal.
    if (ev.attribution_review_needed === true
        && ev.primary_jira_ticket === c.ticket
        && ev.primary_project === c.project
        && ev.attribution_method === 'commit_window') {
      return line;
    }
    ev.attribution_review_needed = true;
    ev.attribution_method = 'commit_window';
    ev.primary_jira_ticket = c.ticket;
    ev.primary_project = c.project;
    return JSON.stringify(ev);
  });

  if (newLines.length !== lines.length) {
    throw new Error(`line count changed ${lines.length} → ${newLines.length}`);
  }

  await atomicWrite(EVENTS_FILE, newLines.join('\n'));
  process.stdout.write(`rewrote ${EVENTS_FILE} — ${single} events back-filled with commit-derived tickets\n`);
  process.stdout.write(`review with: jq -c 'select(.attribution_method == "commit_window")' ${EVENTS_FILE} | head\n`);
  process.stdout.write(`rollback with: cp ${backup} ${EVENTS_FILE}\n`);
}

function printAudit({ scanned, qualified, single, ambiguous, none, repos, candidates }) {
  const out = [];
  out.push('jira back-fill from commits — DRY RUN');
  out.push('─────────────────────────────────────');
  out.push(`  events scanned         ${scanned}`);
  out.push(`  qualified for backfill ${qualified}  (no ticket, has user+ts)`);
  out.push(`    back-fill candidate  ${single}  ← would back-fill (single ticket OR ≥${COMMIT_STRENGTH_OVERRIDE}-commit plurality)`);
  out.push(`    multi-ticket window  ${ambiguous}  (ambiguous, skipped)`);
  out.push(`    no-ticket window     ${none}  (genuine no-ticket work)`);
  out.push(`  window size            ±${WINDOW_HOURS}h   override threshold ≥${COMMIT_STRENGTH_OVERRIDE} commits`);
  out.push(`  repos scanned          ${repos.length}`);
  out.push('');

  if (single > 0) {
    out.push('back-fillable events by user:');
    const evtCount = new Map();
    const sessCount = new Map();
    const seenSession = new Set();
    for (const c of candidates) {
      evtCount.set(c.user, (evtCount.get(c.user) || 0) + 1);
      const sessKey = `${c.sid}|${c.user}`;
      if (!seenSession.has(sessKey)) {
        seenSession.add(sessKey);
        sessCount.set(c.user, (sessCount.get(c.user) || 0) + 1);
      }
    }
    const userRows = [...evtCount.entries()]
      .map(([u, e]) => ({ user: u, events: e, sessions: sessCount.get(u) || 0 }))
      .sort((a, b) => b.events - a.events);
    for (const r of userRows) {
      out.push(`  ${r.user.padEnd(22)}  events=${r.events}  sessions=${r.sessions}`);
    }
    out.push('');

    out.push('tickets that would be assigned (top 15 by event count):');
    const ticketCount = new Map();
    for (const c of candidates) ticketCount.set(c.ticket, (ticketCount.get(c.ticket) || 0) + 1);
    const ticketRows = [...ticketCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    for (const [t, n] of ticketRows) {
      out.push(`${String(n).padStart(6)}  ${t}`);
    }
    out.push('');

    out.push('candidates per user — first 5 sessions (set USER_FILTER=name to focus):');
    if (USER_FILTER) {
      const seen = new Set();
      let printed = 0;
      for (const c of candidates) {
        if (printed >= 30) break;
        if (c.user !== USER_FILTER) continue;
        if (seen.has(c.sid)) continue;
        seen.add(c.sid);
        out.push(`  ${c.sid}  ${c.ts.slice(0, 19)}  → ${c.ticket}   project=${c.project}`);
        printed++;
      }
    } else {
      const seen = new Set();
      const perUser = new Map();
      for (const c of candidates) {
        const key = `${c.sid}|${c.user}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const n = perUser.get(c.user) || 0;
        if (n >= 5) continue;
        perUser.set(c.user, n + 1);
        out.push(`  ${c.user.padEnd(22)}  ${c.sid}  ${c.ts.slice(0, 19)}  → ${c.ticket}   project=${c.project}`);
      }
    }
  }
  out.push('');
  out.push(`to apply: ${process.argv[1]} --apply`);
  process.stdout.write(out.join('\n') + '\n');
}

main().catch(err => {
  process.stderr.write(`error: ${err.stack || err.message}\n`);
  process.exit(1);
});
