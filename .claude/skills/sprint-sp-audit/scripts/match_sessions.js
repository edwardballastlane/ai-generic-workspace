#!/usr/bin/env node
'use strict';

/**
 * match_sessions.js — aggregate local AI session effort signal per Jira ticket.
 *
 * The session-end log appends a *cumulative snapshot* every time a session ends,
 * so a single session_id can appear dozens of times with growing prompts/cost.
 * Naively summing rows overcounts effort ~6x. We dedupe to one record per
 * session_id (the latest snapshot, by ts then prompts) BEFORE aggregating.
 *
 * Usage:
 *   node match_sessions.js PROJ-651 PROJ-700 [...keys]   # explicit ticket list
 *   node match_sessions.js --all                            # every ticket seen
 *   node match_sessions.js PROJ-651 --user "Jane Doe"
 *
 * Output: JSON to stdout, keyed by ticket, with per-ticket totals and the list
 * of contributing sessions. Tickets with no local sessions are returned with
 * sessions: 0 so the caller can still render a row.
 */

const fs = require('node:fs');
const path = require('node:path');

const MEMORY_DIR = path.resolve(__dirname, '../../../../.ai-memory');
// Read the rolling log plus any monthly partitions (session-end-events-YYYY-MM.jsonl).
function logFiles() {
  const files = [];
  const main = path.join(MEMORY_DIR, 'session-end-events.jsonl');
  if (fs.existsSync(main)) files.push(main);
  if (fs.existsSync(MEMORY_DIR)) {
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (/^session-end-events-\d{4}-\d{2}\.jsonl$/.test(f)) files.push(path.join(MEMORY_DIR, f));
    }
  }
  return files;
}

function parseArgs(argv) {
  const keys = [];
  let user = null;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') { user = argv[++i]; }
    else if (a === '--all') { all = true; }
    else if (a.startsWith('--')) { /* ignore unknown flags */ }
    else { keys.push(a.toUpperCase()); }
  }
  return { keys, user, all };
}

function main() {
  const { keys, user, all } = parseArgs(process.argv.slice(2));

  // Dedupe to the latest snapshot per session_id.
  const latest = new Map(); // session_id -> row
  for (const file of logFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'session_end' || !row.session_id) continue;
      const prev = latest.get(row.session_id);
      if (!prev) { latest.set(row.session_id, row); continue; }
      // Prefer later ts; break ties on higher prompt count (more complete snapshot).
      const newer = (row.ts || '') > (prev.ts || '') ||
        ((row.ts || '') === (prev.ts || '') && (row.prompts || 0) >= (prev.prompts || 0));
      if (newer) latest.set(row.session_id, row);
    }
  }

  // Group deduped sessions by ticket.
  const byTicket = new Map();
  for (const row of latest.values()) {
    const ticket = (row.primary_jira_ticket || '').toUpperCase();
    if (!ticket) continue;
    if (user && row.user !== user) continue;
    if (!byTicket.has(ticket)) byTicket.set(ticket, []);
    byTicket.get(ticket).push(row);
  }

  const wanted = all ? [...byTicket.keys()] : keys;
  const out = {};
  for (const ticket of wanted) {
    const rows = byTicket.get(ticket) || [];
    const agg = {
      sessions: rows.length,
      prompts: 0,
      cost_usd: 0,
      lines_added: 0,
      lines_removed: 0,
      duration_ms: 0,
      users: new Set(),
      projects: new Set(),
      first_ts: null,
      last_ts: null,
      session_ids: [],
    };
    for (const r of rows) {
      agg.prompts += r.prompts || 0;
      agg.cost_usd += r.cost_usd || 0;
      agg.lines_added += r.lines_added || 0;
      agg.lines_removed += r.lines_removed || 0;
      agg.duration_ms += r.duration_ms || 0;
      if (r.user) agg.users.add(r.user);
      if (r.project) agg.projects.add(r.project);
      if (!agg.first_ts || (r.ts && r.ts < agg.first_ts)) agg.first_ts = r.ts;
      if (!agg.last_ts || (r.ts && r.ts > agg.last_ts)) agg.last_ts = r.ts;
      agg.session_ids.push(r.session_id);
    }
    out[ticket] = {
      sessions: agg.sessions,
      prompts: agg.prompts,
      cost_usd: Math.round(agg.cost_usd * 100) / 100,
      lines_added: agg.lines_added,
      lines_removed: agg.lines_removed,
      net_lines: agg.lines_added + agg.lines_removed,
      duration_hours: Math.round((agg.duration_ms / 3600000) * 10) / 10,
      users: [...agg.users],
      projects: [...agg.projects],
      first_ts: agg.first_ts,
      last_ts: agg.last_ts,
      session_ids: agg.session_ids,
    };
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
