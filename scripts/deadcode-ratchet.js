#!/usr/bin/env node
'use strict';

/**
 * deadcode-ratchet — CI guard that forbids NEW orphaned script files.
 *
 * Walks scripts/**\/*.{js,ts,cjs,mjs} (excluding *.test.*), builds a haystack
 * from every reference source in the repo (other code, package.json, CI yml,
 * .claude command/agent/settings docs), and flags any candidate that nothing
 * references. New orphans (not in .deadcode-baseline.txt) fail. Detector logic
 * is pure + unit-tested in scripts/_lib/deadcode-ratchet.js.
 *
 * Usage:
 *   node scripts/deadcode-ratchet.js            # check; exit 1 on new orphans
 *   node scripts/deadcode-ratchet.js --update   # freeze current orphans as baseline
 *   node scripts/deadcode-ratchet.js --json
 *
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseBaseline, serializeBaseline, diff } = require('./_lib/ratchet');
const { computeDead } = require('./_lib/deadcode-ratchet');

const HAYSTACK_EXT = new Set(['.js', '.ts', '.cjs', '.mjs', '.json', '.yml', '.yaml', '.md', '.sh', '.cmd']);

// Docs that LIST orphan paths as prose are bookkeeping, not references. Counting
// the port log made all five frozen orphans look alive, so the ratchet reported
// "0 unreferenced" and `--update` kept proposing to empty the baseline — i.e. the
// act of writing down an orphan hid it. (The baseline itself is `.txt`, already
// outside HAYSTACK_EXT.)
const NON_REFERENCE_FILES = new Set([
  'docs/reference/upstream-port.md',
]);
const MAX_FILE_BYTES = 512 * 1024; // skip huge generated files (logs, baselines)

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

/**
 * Repo-relative posix paths of all git-TRACKED files. Using the git index (not a
 * filesystem walk) makes the result deterministic and identical in CI: gitignored
 * session logs / embedding caches that happen to mention a module name never leak
 * into the reference set. Returns null if git is unavailable (caller falls back).
 */
function trackedFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

function main() {
  const root = findWorkspaceRoot();
  const asJson = process.argv.includes('--json');
  const update = process.argv.includes('--update');
  const baselinePath = path.join(root, '.deadcode-baseline.txt');

  const tracked = trackedFiles(root);
  if (!tracked) {
    console.error('deadcode-ratchet: git not available or not a repo — skipping (cannot compute deterministically)');
    process.exit(0);
  }

  // Candidates: tracked code files under scripts/, excluding tests.
  const candidates = tracked
    .filter((rel) => rel.startsWith('scripts/'))
    .filter((rel) => /\.(js|ts|cjs|mjs)$/.test(rel))
    .filter((rel) => !/\.test\.(js|ts)$/.test(rel));

  // Reference sources: every tracked text file (INCLUDING candidates, so cross-file
  // imports count; self-exclusion is handled per-candidate in computeDead).
  // NON_REFERENCE_FILES are excluded — see its declaration.
  const sources = [];
  for (const rel of tracked) {
    if (NON_REFERENCE_FILES.has(rel)) continue;
    if (!HAYSTACK_EXT.has(path.extname(rel))) continue;
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      sources.push({ rel, text: fs.readFileSync(abs, 'utf8') });
    } catch { /* skip unreadable */ }
  }

  const dead = computeDead(candidates, sources);

  if (update) {
    const header = [
      '# deadcode-ratchet baseline — frozen orphaned script files (forbid-growth ratchet).',
      '# A NEW scripts/** file that nothing references and is not listed here fails CI.',
      '# Prefer wiring or deleting the file over adding it here.',
      '# Regenerate with: npm run ratchet:deadcode -- --update',
      '',
    ].join('\n');
    fs.writeFileSync(baselinePath, header + serializeBaseline(dead));
    console.log(`deadcode-ratchet: baseline written with ${dead.length} frozen orphan(s) → ${path.relative(root, baselinePath)}`);
    return;
  }

  const baselineSet = fs.existsSync(baselinePath)
    ? parseBaseline(fs.readFileSync(baselinePath, 'utf8'))
    : new Set();
  const { added, removed } = diff(new Set(dead), baselineSet);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      scanned: candidates.length, dead: dead.length, baselineFrozen: baselineSet.size,
      newOrphans: added, resurrected: removed,
    }, null, 2) + '\n');
  } else {
    console.log('Deadcode ratchet — no new unreferenced script files');
    console.log('─'.repeat(64));
    console.log(`scanned ${candidates.length} script files · ${dead.length} unreferenced · ${baselineSet.size} frozen`);
    if (removed.length) {
      console.log(`\n${removed.length} baseline entr(y/ies) now referenced/removed — tighten with \`npm run ratchet:deadcode -- --update\`:`);
      for (const r of removed) console.log(`  - ${r}`);
    }
    if (added.length) {
      console.log(`\n✗ ${added.length} NEW orphaned file(s) (nothing references them):`);
      for (const a of added) console.log(`  ${a}  → wire it up (require/npm script/command) or delete it.`);
    } else {
      console.log('\n✓ no new orphaned files');
    }
  }

  process.exit(added.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { trackedFiles, findWorkspaceRoot };
