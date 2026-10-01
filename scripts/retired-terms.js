#!/usr/bin/env node
'use strict';

/**
 * retired-terms — CI guard: a deprecated term listed in
 * .retired-terms.txt must not reappear in ACTIVE source. Scans scripts/**\/*.{js,ts,
 * cjs,mjs} (excluding *.test.*) — not docs/specs/tests/logs, which legitimately
 * reference a retirement. Logic is pure + unit-tested (scripts/_lib/retired-terms.js).
 *
 * Usage: node scripts/retired-terms.js [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTerms, findRetired } = require('./_lib/retired-terms');

function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let cur = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function trackedActiveSources(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.toString('utf8').split('\0')
    .filter(Boolean)
    .filter((rel) => rel.startsWith('scripts/') && /\.(js|ts|cjs|mjs)$/.test(rel) && !/\.test\.(js|ts)$/.test(rel))
    .map((rel) => {
      try { return { file: rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }; } catch { return null; }
    })
    .filter(Boolean);
}

function main() {
  const root = findWorkspaceRoot();
  const asJson = process.argv.includes('--json');
  let terms = [];
  try { terms = parseTerms(fs.readFileSync(path.join(root, '.retired-terms.txt'), 'utf8')); } catch { /* none */ }

  if (!terms.length) { console.log('retired-terms: registry empty — nothing to guard'); process.exit(0); }

  const hits = findRetired(trackedActiveSources(root), terms);
  if (asJson) {
    process.stdout.write(JSON.stringify({ terms: terms.length, hits }, null, 2) + '\n');
  } else {
    console.log('Retired-term ratchet — deprecated terms must not reappear in active source');
    console.log('─'.repeat(64));
    console.log(`guarding ${terms.length} retired term(s)`);
    if (hits.length) {
      console.log(`\n✗ ${hits.length} reappearance(s):`);
      for (const h of hits) console.log(`  ${h.file}:${h.line}  "${h.term}"`);
      console.log('\nThis concept was deprecated — remove it, or drop it from .retired-terms.txt if it is genuinely back.');
    } else {
      console.log('\n✓ no retired terms in active source');
    }
  }
  process.exit(hits.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { trackedActiveSources, findWorkspaceRoot };
