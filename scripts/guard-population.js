#!/usr/bin/env node
'use strict';

/**
 * guard-population — tamper-evident registry of Lane's security guards.
 * Scans hook files for `// guard:population <family> <direction>: <why>` markers,
 * fingerprints each guarded region, and fails CI if the set OR any fingerprint
 * differs from .guard-population-baseline.txt — i.e. a new guard, a dropped guard,
 * or a refactor that silently alters guard logic must be re-approved (--update).
 *
 * Usage:
 *   node scripts/guard-population.js            # check; exit 1 on any change
 *   node scripts/guard-population.js --update    # re-approve current guards
 *   node scripts/guard-population.js --json
 *
 * Detector logic is pure + unit-tested in scripts/_lib/guard-population.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseBaseline, serializeBaseline, diff } = require('./_lib/ratchet');
const { extractGuards, keyOf } = require('./_lib/guard-population');

// Files whose safety guards are registered. Add new guard-bearing hooks here.
const GUARD_FILES = ['scripts/hooks/pre-tool-use.js'];

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

function collectGuards(root) {
  const guards = [];
  for (const rel of GUARD_FILES) {
    const abs = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    guards.push(...extractGuards(text, rel));
  }
  return guards;
}

function main() {
  const root = findWorkspaceRoot();
  const asJson = process.argv.includes('--json');
  const update = process.argv.includes('--update');
  const baselinePath = path.join(root, '.guard-population-baseline.txt');

  const guards = collectGuards(root);
  const keys = guards.map(keyOf);

  if (update) {
    const header = [
      '# guard-population baseline — tamper-evident registry of security guards.',
      '# Line = `<file>\\t<family>\\t<direction>\\t<sha>`. A new/dropped/altered guard fails CI.',
      '# Re-approve intentional guard changes with: npm run ratchet:guard -- --update',
      '',
    ].join('\n');
    fs.writeFileSync(baselinePath, header + serializeBaseline(keys));
    console.log(`guard-population: baseline written with ${new Set(keys).size} guard(s) → ${path.relative(root, baselinePath)}`);
    return;
  }

  const baselineSet = fs.existsSync(baselinePath)
    ? parseBaseline(fs.readFileSync(baselinePath, 'utf8'))
    : new Set();
  const { added, removed } = diff(new Set(keys), baselineSet);

  if (asJson) {
    process.stdout.write(JSON.stringify({ guards, added, removed }, null, 2) + '\n');
  } else {
    console.log('Guard-population registry — security guards must not silently change');
    console.log('─'.repeat(64));
    console.log(`registered guards: ${guards.length} (baseline: ${baselineSet.size})`);
    for (const g of guards) console.log(`  • ${g.family} [${g.direction}] ${g.file}`);
    if (added.length) {
      console.log(`\n✗ ${added.length} new/altered guard(s) (not in baseline):`);
      for (const a of added) console.log(`  + ${a.split('\t').slice(1).join(' / ')}`);
    }
    if (removed.length) {
      console.log(`\n✗ ${removed.length} dropped guard(s) (in baseline, now missing):`);
      for (const r of removed) console.log(`  - ${r.split('\t').slice(1).join(' / ')}`);
    }
    if (!added.length && !removed.length) console.log('\n✓ guard registry matches baseline');
    if (added.length || removed.length) {
      console.log('\nIf this change is intentional, re-approve with: npm run ratchet:guard -- --update');
    }
  }

  process.exit(added.length || removed.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { collectGuards, findWorkspaceRoot, GUARD_FILES };
