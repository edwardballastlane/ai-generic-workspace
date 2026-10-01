#!/usr/bin/env node
'use strict';

/**
 * gate-theater-report — read recorded verification verdicts from
 * `.claude/logs/value-events.jsonl` and report whether the /swarm-implement
 * consensus gate is still doing real work or has degraded into rubber-stamping.
 *
 * Detector logic lives
 * in scripts/_lib/gate-theater.js (pure + unit-tested); this is just the I/O shell.
 *
 * Usage:
 *   node scripts/gate-theater-report.js [--json] [--window N] [--threshold R]
 *                                       [--min N] [--strict]
 *
 *   --json       machine-readable output
 *   --window N   only weigh the most recent N verdicts (default 30; 0 = all)
 *   --threshold  PASS-rate at/above which the gate is "theater" (default 0.95)
 *   --min N      minimum decisions before judging (default 8)
 *   --strict     exit 1 when theater is detected (for CI gating). Default: exit 0.
 */

const fs = require('node:fs');
const path = require('node:path');
const { detectTheater, detectByGroup } = require('./_lib/gate-theater');

function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, 'CLAUDE.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function readVerdicts(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'verifier_verdict') continue;
      const d = e.details || {};
      out.push({
        verdict: d.verdict,
        blockers: d.blockers,
        project: d.project || 'unknown',
        panel: d.panel || 'unknown',
        timestamp: e.timestamp,
      });
    } catch { /* skip malformed line */ }
  }
  return out;
}

function num(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || process.argv[i + 1] === undefined) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

function main() {
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const opts = {
    windowSize: num('window', 30),
    rateThreshold: num('threshold', 0.95),
    minDecisions: num('min', 8),
  };

  const logPath = path.join(findWorkspaceRoot(), '.claude', 'logs', 'value-events.jsonl');
  const verdicts = readVerdicts(logPath);

  const overall = detectTheater(verdicts, opts);
  const byProject = detectByGroup(verdicts, (v) => v.project, opts);
  const byPanel = detectByGroup(verdicts, (v) => v.panel, opts);

  if (asJson) {
    process.stdout.write(JSON.stringify({ overall, byProject, byPanel, opts, source: logPath }, null, 2) + '\n');
  } else {
    const pct = (r) => `${(r * 100).toFixed(1)}%`;
    const flag = (d) => {
      if (d.theater) return '⚠️  THEATER';
      return d.reason === 'insufficient-data' ? '·  (n/a)' : '✓  healthy';
    };
    console.log('Gate-theater report — /swarm-implement consensus verdicts');
    console.log('─'.repeat(60));
    console.log(`Overall: ${flag(overall)}  [${overall.passes}/${overall.decisions} PASS, ${pct(overall.passRate)}]  reason=${overall.reason}`);
    console.log(`  window=${opts.windowSize || 'all'}  threshold=${pct(opts.rateThreshold)}  min=${opts.minDecisions}`);
    const groupLines = (title, groups) => {
      const keys = Object.keys(groups);
      if (!keys.length) return;
      console.log(`\nBy ${title}:`);
      for (const k of keys) {
        const d = groups[k];
        console.log(`  ${k.padEnd(24)} ${flag(d)}  [${d.passes}/${d.decisions}, ${pct(d.passRate)}]`);
      }
    };
    groupLines('project', byProject);
    groupLines('panel', byPanel);
    if (!verdicts.length) console.log('\n(no verifier_verdict events recorded yet — run some /swarm-implement tasks)');
  }

  if (strict && overall.theater) process.exit(1);
}

main();
