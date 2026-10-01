#!/usr/bin/env node
'use strict';

/**
 * verify-evidence — re-validate the `completion_evidence` records for a task: the
 * cited artifact must still hash-match, the command must have exited 0, and the
 * claimed assertion must appear in the output. Fails (exit 1) on any stale/forged
 * or hollow evidence — the completion gate.
 *
 * Usage:
 *   node scripts/verify-evidence.js --task T-3 [--json]
 *   node scripts/verify-evidence.js            # verify all recorded tasks
 */

const fs = require('node:fs');
const path = require('node:path');
const { verifyRecord } = require('./_lib/evidence');

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

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function readEvidence(root, taskFilter) {
  const logPath = path.join(root, '.claude', 'logs', 'value-events.jsonl');
  if (!fs.existsSync(logPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'completion_evidence') continue;
      const d = e.details || {};
      if (taskFilter && d.taskId !== taskFilter) continue;
      out.push(d);
    } catch { /* skip */ }
  }
  return out;
}

function main() {
  const root = findWorkspaceRoot();
  const asJson = process.argv.includes('--json');
  const task = arg('task');
  const records = readEvidence(root, task);

  const results = records.map((rec) => {
    let text = null;
    try { text = fs.readFileSync(path.join(root, rec.artifact), 'utf8'); } catch {}
    if (text == null) return { rec, ok: false, errors: [`artifact missing: ${rec.artifact}`] };
    return { rec, ...verifyRecord(rec, text) };
  });

  const failed = results.filter((r) => !r.ok);
  if (asJson) {
    process.stdout.write(JSON.stringify({ task: task || 'all', total: results.length, failed: failed.length, results }, null, 2) + '\n');
  } else {
    console.log(`Evidence verification — ${task || 'all tasks'}`);
    console.log('─'.repeat(56));
    if (!results.length) console.log('(no completion_evidence records found)');
    for (const r of results) {
      const tag = r.ok ? '✓' : '✗';
      console.log(`${tag} ${r.rec.taskId}/${r.rec.criterionId}  ${r.rec.command}`);
      for (const e of r.errors || []) console.log(`    → ${e}`);
    }
    if (failed.length) console.log(`\n✗ ${failed.length} of ${results.length} evidence record(s) failed`);
    else if (results.length) console.log(`\n✓ all ${results.length} evidence record(s) valid`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { readEvidence };
