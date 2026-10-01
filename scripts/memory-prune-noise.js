#!/usr/bin/env node
'use strict';

/**
 * memory-prune-noise — one-time (repeatable, idempotent) cleanup that removes
 * noise `session_summary` observations from shared team memory and the local
 * store. "Noise" is decided by _lib/summary-quality.js (prompt leaks from Lane's
 * own headless calls, log-session auto-commits, bare tickets, follow-ups, and
 * sensitive data that must not leave FO folders).
 *
 * It rewrites, in place:
 *   - .ai-memory/observations-export/<contributor>.jsonl   (shared, git-tracked)
 *   - .ai-memory/observations/<scope>.jsonl                (local store)
 * and refreshes the export manifest.
 *
 * Ongoing prevention lives at the two write gates (session-stop.js fallback and
 * memory-export.js exportChunk); this script is for the backlog already written.
 *
 * Usage:
 *   node scripts/memory-prune-noise.js            # apply
 *   node scripts/memory-prune-noise.js --dry-run  # report only, write nothing
 */

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteSync } = require('./_lib/process');
const { isNoiseSummary, classifySummary, containsSensitiveData, inferProject } = require('./_lib/summary-quality');
const { findWorkspaceRoot, refreshManifest } = require('./memory-export');

/**
 * Partition JSONL lines into kept vs dropped, and backfill an empty `project` on
 * kept observations. Malformed lines are kept verbatim. Drops noise session_summaries
 * AND any observation carrying real sensitive data (all types). Returns counts + tallies.
 *
 * @param {string} text
 * @param {string} [rootDir] workspace root, for the sensitive-data policy and the
 *   registered-project list (tests pass a tempdir)
 * @returns {{kept: string[], dropped: object[], reasons: Record<string, number>, backfilled: number}}
 */
function pruneJsonl(text, rootDir) {
  const kept = [];
  const dropped = [];
  const reasons = {};
  let backfilled = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { kept.push(line); continue; }
    let reason = '';
    if (o && o.type === 'session_summary' && isNoiseSummary(o)) reason = classifySummary(o).reason || 'noise';
    else if (containsSensitiveData(o, rootDir)) reason = 'sensitive-data';
    if (reason) {
      reasons[reason] = (reasons[reason] || 0) + 1;
      dropped.push(o);
      continue;
    }
    // Backfill an empty project from content so board/filters stay useful.
    if (o && !o.project) {
      const p = inferProject(o, rootDir);
      if (p) { o.project = p; backfilled += 1; kept.push(JSON.stringify(o)); continue; }
    }
    kept.push(line);
  }
  return { kept, dropped, reasons, backfilled };
}

function mergeReasons(into, from) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v;
}

function pruneFile(file, dryRun, totals) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const { kept, dropped, reasons, backfilled } = pruneJsonl(text);
  if (dropped.length === 0 && backfilled === 0) return;
  mergeReasons(totals.reasons, reasons);
  totals.dropped += dropped.length;
  totals.backfilled += backfilled;
  totals.files.push({ file, dropped: dropped.length, backfilled, reasons });
  if (!dryRun) {
    atomicWriteSync(file, kept.length ? kept.join('\n') + '\n' : '');
  }
}

function collectFiles(root) {
  const files = [];
  const exportDir = path.join(root, '.ai-memory', 'observations-export');
  if (fs.existsSync(exportDir)) {
    for (const f of fs.readdirSync(exportDir)) {
      if (f.endsWith('.jsonl')) files.push(path.join(exportDir, f));
    }
  }
  const storeDir = path.join(root, '.ai-memory', 'observations');
  if (fs.existsSync(storeDir)) {
    for (const f of fs.readdirSync(storeDir)) {
      if (f.endsWith('.jsonl')) files.push(path.join(storeDir, f));
    }
  }
  return files;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const root = findWorkspaceRoot();
  const totals = { dropped: 0, backfilled: 0, reasons: {}, files: [] };

  for (const file of collectFiles(root)) pruneFile(file, dryRun, totals);

  if (!dryRun && (totals.dropped > 0 || totals.backfilled > 0)) {
    try { refreshManifest(root); } catch { /* manifest optional */ }
  }

  const mode = dryRun ? '[dry-run] would remove' : 'removed';
  console.log(`memory-prune-noise: ${mode} ${totals.dropped} noise/customer observations; backfilled ${totals.backfilled} project fields`);
  const order = Object.entries(totals.reasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of order) console.log(`  ${String(n).padStart(4)}  ${reason}`);
  for (const f of totals.files) {
    console.log(`  · ${path.relative(root, f.file)} (-${f.dropped}${f.backfilled ? ` ~${f.backfilled}` : ''})`);
  }
  if (dryRun) console.log('Run without --dry-run to apply.');
}

if (require.main === module) main();

module.exports = { pruneJsonl };
