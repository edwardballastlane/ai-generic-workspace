#!/usr/bin/env ts-node
/**
 * Backfill `project` and `jira_ticket` on .ai-memory/session-end-events.jsonl
 * for events that landed with empty / "unknown" / "unspecified" values.
 *
 * Sources, in priority order:
 *   1. Per-session sidecar at .ai-session/by-id/<session_id>.json
 *   2. Jira ticket → project map learned from events that already carry both
 *      (e.g. ticket PROJ-1234 lived in repo-X 12× → PROJ-1234 → repo-X)
 *   3. Task title regex (e.g. PROJ-XXXX) for jira_ticket, then re-applies the map
 *   4. Task title contains a known project slug
 *
 * Usage:
 *   npx ts-node scripts/self-improvement/backfill-event-projects.ts
 *   npx ts-node scripts/self-improvement/backfill-event-projects.ts --apply
 */

import * as fs from 'fs';
import * as path from 'path';

function findWorkspaceRoot(): string {
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.ai-memory'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const ROOT = findWorkspaceRoot();
const EVENTS = path.join(ROOT, '.ai-memory/session-end-events.jsonl');
const SIDECAR_DIR = path.join(ROOT, '.ai-session/by-id');
const CONTEXTS_DIR = path.join(ROOT, '.ai-contexts');
const TICKET_RE = /\b([A-Z]+-\d{3,5})\b/;

const KNOWN_PROJECTS = (() => {
  try {
    return fs.readdirSync(CONTEXTS_DIR)
      .filter(f => f.endsWith('.yaml'))
      .map(f => f.replace(/\.yaml$/, ''));
  } catch { return []; }
})();

interface Event {
  type: string;
  session_id: string;
  project?: string;
  jira_ticket?: string;
  task?: string;
  ts?: string;
  [k: string]: unknown;
}

function isPopulated(p: string | undefined): boolean {
  return !!p && p !== 'unspecified' && p !== 'unknown' && p !== '';
}

function loadEvents(): Event[] {
  const txt = fs.readFileSync(EVENTS, 'utf8');
  return txt.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) as Event; } catch { return null as unknown as Event; }
  }).filter(Boolean);
}

function readSidecarMap(): Map<string, { project: string; jira_ticket: string; task: string }> {
  const map = new Map<string, { project: string; jira_ticket: string; task: string }>();
  try {
    for (const f of fs.readdirSync(SIDECAR_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SIDECAR_DIR, f), 'utf8'));
        map.set(s.session_id || f.replace(/\.json$/, ''), {
          project: s.project || '',
          jira_ticket: s.jira_ticket || '',
          task: s.task || '',
        });
      } catch { /* skip */ }
    }
  } catch { /* sidecar dir missing */ }
  return map;
}

function buildTicketProjectMap(events: Event[]): Map<string, string> {
  // For each ticket, count populated projects; pick the most common.
  const tally = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (!e.jira_ticket || !isPopulated(e.project)) continue;
    if (!tally.has(e.jira_ticket)) tally.set(e.jira_ticket, new Map());
    const m = tally.get(e.jira_ticket)!;
    m.set(e.project!, (m.get(e.project!) || 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [ticket, projCounts] of tally) {
    let best = '', bestN = -1;
    for (const [proj, n] of projCounts) {
      if (n > bestN) { best = proj; bestN = n; }
    }
    if (best) out.set(ticket, best);
  }
  return out;
}

function buildSessionProjectMap(events: Event[]): Map<string, string> {
  // For sessions that have at least one populated project, pick the most common
  // populated project. Avoids "unknown" overwriting a real project on later events.
  const tally = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (!isPopulated(e.project)) continue;
    if (!tally.has(e.session_id)) tally.set(e.session_id, new Map());
    const m = tally.get(e.session_id)!;
    m.set(e.project!, (m.get(e.project!) || 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [sid, projCounts] of tally) {
    let best = '', bestN = -1;
    for (const [proj, n] of projCounts) {
      if (n > bestN) { best = proj; bestN = n; }
    }
    if (best) out.set(sid, best);
  }
  return out;
}

function extractTicketFromTask(task: string): string {
  if (!task) return '';
  const m = task.match(TICKET_RE);
  return m ? m[1] : '';
}

function inferProjectFromTask(task: string): string {
  if (!task) return '';
  const lower = task.toLowerCase();
  for (const p of KNOWN_PROJECTS) {
    if (lower.includes(p)) return p;
  }
  return '';
}

interface BackfillSources {
  sidecars: Map<string, { project: string; jira_ticket: string; task: string }>;
  ticketProj: Map<string, string>;
  sessionProj: Map<string, string>;
}

interface BackfillCounts {
  projectFilled: number;
  jiraFilled: number;
  unchanged: number;
  projectSource: Record<string, number>;
  jiraSource: Record<string, number>;
}

function emptyCounts(): BackfillCounts {
  return {
    projectFilled: 0,
    jiraFilled: 0,
    unchanged: 0,
    projectSource: { sidecar: 0, ticket_map: 0, task_slug: 0, session_majority: 0 },
    jiraSource: { sidecar: 0, task_regex: 0, sidecar_task: 0 },
  };
}

function fillJira(e: Event, sidecar: BackfillSources['sidecars'] extends Map<string, infer V> ? V | undefined : never, counts: BackfillCounts): void {
  if (e.jira_ticket) return;
  if (sidecar?.jira_ticket) {
    e.jira_ticket = sidecar.jira_ticket;
    counts.jiraSource.sidecar++;
    counts.jiraFilled++;
    return;
  }
  const fromTask = extractTicketFromTask(e.task || '');
  if (fromTask) {
    e.jira_ticket = fromTask;
    counts.jiraSource.task_regex++;
    counts.jiraFilled++;
    return;
  }
  if (sidecar?.task) {
    const fromSidecarTask = extractTicketFromTask(sidecar.task);
    if (fromSidecarTask) {
      e.jira_ticket = fromSidecarTask;
      counts.jiraSource.sidecar_task++;
      counts.jiraFilled++;
    }
  }
}

function fillProject(e: Event, sources: BackfillSources, counts: BackfillCounts): void {
  if (isPopulated(e.project)) return;
  const sidecar = sources.sidecars.get(e.session_id);
  if (sidecar && isPopulated(sidecar.project)) {
    e.project = sidecar.project;
    counts.projectSource.sidecar++;
    counts.projectFilled++;
    return;
  }
  if (e.jira_ticket && sources.ticketProj.has(e.jira_ticket)) {
    e.project = sources.ticketProj.get(e.jira_ticket)!;
    counts.projectSource.ticket_map++;
    counts.projectFilled++;
    return;
  }
  if (e.task) {
    const slug = inferProjectFromTask(e.task);
    if (slug) {
      e.project = slug;
      counts.projectSource.task_slug++;
      counts.projectFilled++;
      return;
    }
  }
  if (sources.sessionProj.has(e.session_id)) {
    e.project = sources.sessionProj.get(e.session_id)!;
    counts.projectSource.session_majority++;
    counts.projectFilled++;
  }
}

function backfillEvent(e: Event, sources: BackfillSources, counts: BackfillCounts): void {
  if (e.jira_ticket && isPopulated(e.project)) { counts.unchanged++; return; }
  const sidecar = sources.sidecars.get(e.session_id);
  fillJira(e, sidecar, counts);
  fillProject(e, sources, counts);
}

function printReport(counts: BackfillCounts, total: number, apply: boolean): void {
  console.log('=== Event backfill ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Total events:       ${total}`);
  console.log(`Project backfilled: ${counts.projectFilled}`);
  console.log(`Jira backfilled:    ${counts.jiraFilled}`);
  console.log(`Unchanged:          ${counts.unchanged}\n`);
  console.log('Project backfill sources:');
  for (const [k, v] of Object.entries(counts.projectSource)) {
    if (v > 0) console.log(`  ${v.toString().padStart(4)} × ${k}`);
  }
  console.log('\nJira backfill sources:');
  for (const [k, v] of Object.entries(counts.jiraSource)) {
    if (v > 0) console.log(`  ${v.toString().padStart(4)} × ${k}`);
  }
}

function rewrite(events: Event[]): string {
  const tmp = EVENTS + '.bak.' + Date.now();
  fs.copyFileSync(EVENTS, tmp);
  const out = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(EVENTS, out);
  return tmp;
}

function main() {
  const apply = process.argv.includes('--apply');
  const events = loadEvents();
  const sources: BackfillSources = {
    sidecars: readSidecarMap(),
    ticketProj: buildTicketProjectMap(events),
    sessionProj: buildSessionProjectMap(events),
  };
  const counts = emptyCounts();
  for (const e of events) backfillEvent(e, sources, counts);
  printReport(counts, events.length, apply);
  if (!apply) {
    console.log(`\n→ Run with --apply to rewrite ${EVENTS}`);
    return;
  }
  const tmp = rewrite(events);
  console.log(`\n✓ Rewrote ${EVENTS}`);
  console.log(`  Backup at ${tmp}`);
}

main();
