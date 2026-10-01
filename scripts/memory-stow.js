#!/usr/bin/env node
'use strict';

/**
 * memory-stow — the tiered-decay pass. Sweeps the observation
 * store; stale entries (by tier: aging >= 30d, perishable >= 7d; pinned never) RETIRE to a
 * cold archive — a copy appended to `.ai-memory/observations-cold.jsonl` and `valid_to` set
 * on the live record so retrieval/export already exclude it. Nothing is deleted.
 *
 * Usage:
 *   node scripts/memory-stow.js            # apply
 *   node scripts/memory-stow.js --dry-run  # report what it would retire, write nothing
 *
 * Like memory:prune-noise, this is an operator/periodic pass; on the git-shared chunks it
 * inherits the jsonl-union re-prune-after-merge discipline (see memory-summary-noise-filter).
 */

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteSync } = require('./_lib/process');
const store = require('./_lib/memory-store');
const { classify, tierOf } = require('./_lib/memory-tiers');
const { findWorkspaceRoot } = require('./memory-export');

function coldPath(root) { return path.join(root, '.ai-memory', 'observations-cold.jsonl'); }

function stowScope(root, scope, now, nowIso, dry, totals) {
  const file = store.scopeFile(root, scope);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const outLines = [];
  const cold = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { outLines.push(line); continue; } // keep malformed verbatim
    if (o && !o.valid_to) {                       // only currently-valid records are candidates
      const c = classify(o, now);
      if (c.stale) {
        totals.byTier[c.tier] = (totals.byTier[c.tier] || 0) + 1;
        totals.retired += 1;
        cold.push(JSON.stringify(o));             // archive the original
        outLines.push(JSON.stringify({ ...o, valid_to: nowIso, cold: true, stow_tier: c.tier }));
        continue;
      }
    }
    outLines.push(line);
  }
  if (!dry && cold.length) {
    fs.mkdirSync(path.dirname(coldPath(root)), { recursive: true });
    fs.appendFileSync(coldPath(root), cold.join('\n') + '\n');
    atomicWriteSync(file, outLines.length ? outLines.join('\n') + '\n' : '');
  }
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const root = findWorkspaceRoot();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const totals = { retired: 0, byTier: {} };

  for (const scope of store.SCOPES) stowScope(root, scope, now, nowIso, dry, totals);

  // Live vs retired snapshot (currently-valid, by tier) for context.
  const live = store.readAll(root).filter((o) => !o.valid_to);
  const liveByTier = {};
  for (const o of live) { const t = tierOf(o); liveByTier[t] = (liveByTier[t] || 0) + 1; }

  const mode = dry ? '[dry-run] would retire' : 'retired';
  console.log(`memory-stow: ${mode} ${totals.retired} stale observation(s) → cold archive`);
  for (const [tier, n] of Object.entries(totals.byTier).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${tier}`);
  }
  console.log(`  live now: ${live.length} (${Object.entries(liveByTier).map(([t, n]) => `${t}:${n}`).join(' ')})`);
  if (dry && totals.retired) console.log('Run without --dry-run to apply.');
}

if (require.main === module) main();

module.exports = { stowScope };
