#!/usr/bin/env node
'use strict';

// git-merge-jsonl-union.js — merge driver for append-only JSONL event logs.
//
// Used for several append-only event streams written by many machines, e.g.:
//   - .ai-memory/session-end-events.jsonl   (keys: session_id, ts)
//   - .claude/logs/value-events.jsonl       (keys: sessionId,  timestamp)
// Any conflict is a "both sides added new events" situation, not a "same event
// edited differently" one, so we resolve by union — combine ours + theirs,
// deduplicate, sort by timestamp, write back.
//
// Register once per clone with:  ./scripts/setup-merge-drivers.sh
//
// Git invokes with:  %O %A %B  (ancestor, ours, theirs).
// On success: write merged output to %A and exit 0. On failure: exit non-zero
// and git falls back to conflict markers.

const fs = require('node:fs');

// Ensure executable bit — safe no-op when already set or read-only fs.
try { fs.chmodSync(__filename, 0o755); } catch { /* read-only fs */ }

/**
 * Load a JSONL file as a list of [kind, item] entries.
 *  - 'json' entries hold a parsed object.
 *  - 'raw'  entries hold the original line string (preserve unparseable data).
 * Empty/whitespace-only lines are dropped. Missing files yield [].
 */
function load(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    try {
      items.push(['json', JSON.parse(line)]);
    } catch {
      // Preserve unparseable lines verbatim — never silently drop data.
      items.push(['raw', line]);
    }
  }
  return items;
}

/**
 * Read the session identifier from either schema:
 *  - session-end-events.jsonl uses `session_id`
 *  - .claude/logs/value-events.jsonl uses `sessionId`
 */
function sidOf(item) {
  if (typeof item.session_id === 'string') return item.session_id;
  if (typeof item.sessionId === 'string') return item.sessionId;
  return '';
}

/**
 * Read the timestamp from either schema:
 *  - session-end-events.jsonl uses `ts`
 *  - .claude/logs/value-events.jsonl uses `timestamp`
 */
function tsValue(item) {
  if (typeof item.ts === 'string') return item.ts;
  if (typeof item.timestamp === 'string') return item.timestamp;
  return '';
}

/**
 * Build the dedupe key for an entry.
 *  - When a session id is present (session-end-events), identity is
 *    (session_id, ts): re-written events with the same id+ts collapse to one.
 *  - When no session id is present (value-events always carry an empty
 *    sessionId), distinct events can share a timestamp, so identity falls back
 *    to the full content. Only byte-identical lines dedupe — never distinct
 *    events — which avoids data loss while keeping re-merges idempotent.
 */
function keyOf(kind, item) {
  if (kind === 'json') {
    const sid = sidOf(item);
    const ts = tsValue(item);
    if (sid !== '') return `json ${sid} ${ts}`;
    return `json-content ${ts} ${JSON.stringify(item)}`;
  }
  return `raw ${item}`;
}

/** Sort key: ts for json entries, '' for raw (raw sorts before timestamped). */
function tsOf([kind, item]) {
  if (kind === 'json') return tsValue(item);
  return '';
}

/** Stable string-compare sort by ts. */
function compareByTs(a, b) {
  const ta = tsOf(a);
  const tb = tsOf(b);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}

/** Serialise a merged entry to its on-disk line (no trailing newline). */
function serialise([kind, item]) {
  return kind === 'json' ? JSON.stringify(item) : item;
}

function main(argv) {
  if (argv.length < 3) {
    process.stderr.write('Usage: git-merge-jsonl-union.js <BASE> <OURS> <THEIRS>\n');
    process.exit(2);
  }
  // BASE is intentionally unused (union strategy ignores ancestor).
  const oursPath = argv[1];
  const theirsPath = argv[2];

  const ours = load(oursPath);
  const theirs = load(theirsPath);

  const seen = new Map();
  for (const [kind, item] of [...ours, ...theirs]) {
    const k = keyOf(kind, item);
    if (!seen.has(k)) seen.set(k, [kind, item]);
  }

  const merged = [...seen.values()].sort(compareByTs);
  const out = merged.map(serialise).join('\n') + (merged.length ? '\n' : '');
  fs.writeFileSync(oursPath, out);

  process.stderr.write(
    `jsonl-union: merged ${ours.length} ours + ${theirs.length} theirs ` +
    `→ ${merged.length} unique events\n`
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`jsonl-union: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { load, keyOf, tsOf, compareByTs, serialise, sidOf, tsValue };
