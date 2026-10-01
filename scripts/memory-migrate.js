#!/usr/bin/env node
'use strict';

/**
 * memory-migrate CLI — seed the observation store from Lane's existing KBs
 * (team ExpeL rules + curated MEMORY.md). Idempotent: re-running only adds new
 * entries (saveObservation dedups by id).
 *
 * Usage:
 *   node scripts/memory-migrate.js [--dry-run] [--root <dir>] [--memory-dir <dir>]
 *
 *   --memory-dir  where MEMORY.md + memory/*.md live (default: the Claude auto-memory
 *                 dir if resolvable via $CLAUDE_MEMORY_DIR, else skipped)
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./_lib/memory-store');
const { rulesToObservations, parseMemoryIndex, memoryFileToObservation } = require('./_lib/memory-migrate');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let cur = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(cur, 'CLAUDE.md'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function loadRules(root) {
  const p = path.join(root, 'scripts', 'self-improvement', 'rules-shared.json');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : (data.rules || []);
  } catch { return []; }
}

function loadMemoryObservations(memoryDir) {
  if (!memoryDir) return [];
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  let indexText;
  try { indexText = fs.readFileSync(indexPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const entry of parseMemoryIndex(indexText)) {
    let body = '';
    try { body = fs.readFileSync(path.join(memoryDir, entry.file), 'utf8'); } catch { /* index-only */ }
    out.push(memoryFileToObservation(entry, body));
  }
  return out;
}

function main() {
  const root = arg('root', findWorkspaceRoot());
  const dryRun = process.argv.includes('--dry-run');
  const memoryDir = arg('memory-dir', process.env.CLAUDE_MEMORY_DIR || '');

  const ruleObs = rulesToObservations(loadRules(root));
  const memObs = loadMemoryObservations(memoryDir);
  const all = [...ruleObs, ...memObs];

  const before = new Set(store.readAll(root, ['project']).map((o) => o.id));
  let added = 0;
  for (const o of all) {
    if (before.has(o.id)) continue;
    if (!dryRun) store.saveObservation(root, o, { consolidate: false }); // replay history verbatim
    added += 1;
  }

  const summary = {
    fromRules: ruleObs.length,
    fromMemory: memObs.length,
    alreadyPresent: all.length - added,
    added: dryRun ? 0 : added,
    wouldAdd: dryRun ? added : undefined,
    dryRun,
  };
  console.log(`memory-migrate: rules=${summary.fromRules} memory=${summary.fromMemory} ` +
    `${dryRun ? `would add ${added}` : `added ${added}`} (already present: ${summary.alreadyPresent})`);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { loadRules, loadMemoryObservations, findWorkspaceRoot };
