#!/usr/bin/env node
'use strict';

/**
 * backfill_sessions.js — write a confirmed ticket↔session mapping back into the
 * session-end-events log, so AI-effort attribution survives for tickets whose work
 * the commit-based backfiller can't catch (unkeyed direct-to-master hotfixes that
 * this skill matched semantically via PRs).
 *
 * SAFETY — this file is git-tracked, shared team data feeding token/cost reports:
 *   • Only fills events whose primary_jira_ticket is CURRENTLY EMPTY. It never
 *     overwrites an existing attribution (e.g. a session already tagged PROJ-550)
 *     unless you pass --force, which you should basically never do.
 *   • --dry-run is the DEFAULT. Nothing is written until you pass --apply.
 *   • --apply backs the file up (.bak-<latest ts>) before rewriting, and uses the
 *     repo's atomicWrite so a concurrent terminal can't tear the file.
 *   • Idempotent: re-running with the same map is a no-op.
 *
 * The mapping must be CONFIRMED by you (the model/operator), not guessed here. Derive
 * it as SKILL.md Step 5 describes: semantic PR match → local-git commit window for that
 * branch → the session_end event(s) whose ts falls in that window AND are still empty.
 * If no empty session sits in the window, there is nothing to backfill — say so, don't
 * invent one.
 *
 * Usage:
 *   node backfill_sessions.js --map "PROJ-865=2bc53ef8-...,fbf24ce6-..." [--map "PROJ-866=..."]
 *   node backfill_sessions.js --map-file mapping.json            # { "PROJ-123": ["sid", ...] }
 *   node backfill_sessions.js ... --apply
 *   node backfill_sessions.js --self-test                        # fixture test, touches no real data
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '../../../..');
let atomicWrite;
try { ({ atomicWrite } = require(path.join(ROOT, 'scripts', '_lib', 'process'))); }
catch { atomicWrite = (p, s) => fs.writeFileSync(p, s); } // fallback for fixture runs outside the repo

const REAL_TICKET_RE = /^[A-Z]+-\d+$/;

function parseArgs(argv) {
  const map = {};
  let apply = false, force = false, selfTest = false, eventsFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--force') force = true;
    else if (a === '--self-test') selfTest = true;
    else if (a === '--events') eventsFile = argv[++i];
    else if (a === '--map') {
      const [ticket, sids] = argv[++i].split('=');
      (map[ticket.toUpperCase()] ||= []).push(...sids.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--map-file') {
      const obj = JSON.parse(fs.readFileSync(argv[++i], 'utf8'));
      for (const [t, sids] of Object.entries(obj)) (map[t.toUpperCase()] ||= []).push(...sids);
    }
  }
  return { map, apply, force, selfTest, eventsFile };
}

/**
 * Apply the mapping to the raw JSONL text. Pure function so it's unit-testable.
 * Returns { text, fills:[{session_id,ticket,ts}], skipped:[{session_id,reason,existing}] }.
 */
function applyMapping(jsonl, map, force) {
  // Invert: session_id -> ticket (last one wins if a sid is mapped twice).
  const sidToTicket = {};
  for (const [ticket, sids] of Object.entries(map)) {
    if (!REAL_TICKET_RE.test(ticket)) throw new Error(`bad ticket key: ${ticket}`);
    for (const sid of sids) sidToTicket[sid] = ticket;
  }
  const fills = [], skipped = [];
  const seenSids = new Set();
  const lines = jsonl.split('\n');
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let row;
    try { row = JSON.parse(line); } catch { return line; }
    const want = sidToTicket[row.session_id];
    if (!want || row.type !== 'session_end') return line;
    seenSids.add(row.session_id);
    const existing = (row.primary_jira_ticket || '').trim();
    if (existing && existing !== want && !force) {
      skipped.push({ session_id: row.session_id, reason: 'already-attributed', existing, ts: row.ts });
      return line;
    }
    if (existing === want) return line; // idempotent
    row.primary_jira_ticket = want;
    fills.push({ session_id: row.session_id, ticket: want, ts: row.ts });
    return JSON.stringify(row);
  });
  // Report mapped sids that matched no row at all.
  for (const [sid, ticket] of Object.entries(sidToTicket)) {
    if (!seenSids.has(sid)) skipped.push({ session_id: sid, reason: 'no-matching-event', ticket });
  }
  return { text: out.join('\n'), fills, skipped };
}

function selfTest() {
  const fixture = [
    JSON.stringify({ type: 'session_end', session_id: 'A', ts: '2026-06-19T12:00:00Z', primary_jira_ticket: '' }),
    JSON.stringify({ type: 'session_end', session_id: 'B', ts: '2026-06-19T13:00:00Z', primary_jira_ticket: 'PROJ-550' }),
    JSON.stringify({ type: 'session_end', session_id: 'C', ts: '2026-06-19T14:00:00Z', primary_jira_ticket: '' }),
  ].join('\n');
  const map = { 'PROJ-866': ['A'], 'PROJ-550': ['B'], 'PROJ-999': ['Z'] };
  const r = applyMapping(fixture, map, false);
  const assert = require('node:assert');
  // A: empty -> filled. B: already correct -> idempotent no-op (not in fills). Z: no event.
  assert.deepStrictEqual(r.fills.map((f) => f.session_id), ['A']);
  assert.ok(JSON.parse(r.text.split('\n')[0]).primary_jira_ticket === 'PROJ-866');
  assert.ok(JSON.parse(r.text.split('\n')[1]).primary_jira_ticket === 'PROJ-550'); // untouched
  assert.ok(r.skipped.some((s) => s.reason === 'no-matching-event' && s.session_id === 'Z'));
  // Overwrite guard: mapping B to a different ticket without --force must skip.
  const r2 = applyMapping(fixture, { 'PROJ-865': ['B'] }, false);
  assert.deepStrictEqual(r2.fills, []);
  assert.ok(r2.skipped.some((s) => s.reason === 'already-attributed' && s.existing === 'PROJ-550'));
  console.log('self-test: PASS');
}

function main() {
  const { map, apply, force, selfTest: st, eventsFile } = parseArgs(process.argv.slice(2));
  if (st) return selfTest();

  if (!Object.keys(map).length) {
    console.error('no mapping provided (use --map "PROJ-123=sid,sid" or --map-file). Nothing to do.');
    process.exit(0);
  }
  const EVENTS = eventsFile || path.join(ROOT, '.ai-memory', 'session-end-events.jsonl');
  if (!fs.existsSync(EVENTS)) { console.error(`no events file at ${EVENTS}`); process.exit(1); }

  const jsonl = fs.readFileSync(EVENTS, 'utf8');
  const { text, fills, skipped } = applyMapping(jsonl, map, force);

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', events_file: EVENTS, fills, skipped }, null, 2));

  if (!apply) { console.log('\n(dry-run — pass --apply to write. Backs up first.)'); return; }
  if (!fills.length) { console.log('\nnothing to write.'); return; }

  // Back up the latest-ts snapshot next to the file before rewriting.
  const bak = `${EVENTS}.bak`;
  fs.copyFileSync(EVENTS, bak);
  atomicWrite(EVENTS, text);
  console.log(`\nwrote ${fills.length} attribution(s). backup at ${path.basename(bak)}`);
}

main();
