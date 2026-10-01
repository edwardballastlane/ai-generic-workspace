'use strict';

/**
 * Shared access to the session-event telemetry log.
 *
 * History bloat fix: the log used to be one file (`session-end-events.jsonl`)
 * re-committed in full on every session-stop — hundreds of multi-MB blobs in
 * git history, which made pushes fail and clones slow. We now shard by month:
 *
 *   .ai-memory/session-end-events.jsonl            ← legacy archive (frozen, read-only)
 *   .ai-memory/session-end-events-2026-06.jsonl    ← current month (the only file that changes)
 *   .ai-memory/session-end-events-2026-07.jsonl    ← next month, etc.
 *
 * New events append to the current month's shard, so closed months never change
 * → no new blobs, history growth is bounded. The legacy file is left in place as
 * a frozen archive (deleting/splitting it would create the very churn we avoid).
 *
 * Readers must union the legacy file + every shard. Use `readAllEvents()` /
 * `listEventFiles()` here instead of hardcoding a single path.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_NAME = 'session-end-events.jsonl';
// session-end-events-YYYY-MM.jsonl
const SHARD_RE = /^session-end-events-\d{4}-\d{2}\.jsonl$/;

function eventsDir(root) { return path.join(root, '.ai-memory'); }
function legacyPath(root) { return path.join(eventsDir(root), LEGACY_NAME); }

/** "YYYY-MM" (UTC) for a Date or ISO timestamp string. */
function monthKey(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function shardPath(root, monthOrTs) {
  const mk = /^\d{4}-\d{2}$/.test(String(monthOrTs)) ? String(monthOrTs) : monthKey(monthOrTs);
  return path.join(eventsDir(root), `session-end-events-${mk}.jsonl`);
}

/** The shard new events should append to right now. */
function currentShardPath(root, now) {
  return shardPath(root, monthKey(now || new Date()));
}

/**
 * Every event file, in chronological-ish order: legacy archive first (if it
 * exists), then monthly shards ascending by name.
 */
function listEventFiles(root) {
  const dir = eventsDir(root);
  const out = [];
  const legacy = legacyPath(root);
  if (fs.existsSync(legacy)) out.push(legacy);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* dir may not exist yet */ }
  for (const f of entries.filter(f => SHARD_RE.test(f)).sort()) {
    out.push(path.join(dir, f));
  }
  return out;
}

/** All non-empty trimmed lines across every event file, in file order. */
function readAllLines(root) {
  const lines = [];
  for (const file of listEventFiles(root)) {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

/**
 * All parsed events across every file. Malformed lines are skipped (parity with
 * the old per-reader `try/JSON.parse/catch` loops).
 * @param {string} root
 * @param {string} [filterType] - if set, only events whose `.type` matches
 */
function readAllEvents(root, filterType) {
  const events = [];
  for (const line of readAllLines(root)) {
    try {
      const e = JSON.parse(line);
      if (e && (!filterType || e.type === filterType)) events.push(e);
    } catch { /* skip malformed */ }
  }
  return events;
}

module.exports = {
  LEGACY_NAME,
  SHARD_RE,
  eventsDir,
  legacyPath,
  monthKey,
  shardPath,
  currentShardPath,
  listEventFiles,
  readAllLines,
  readAllEvents,
};
