#!/usr/bin/env node
'use strict';

/**
 * verify-gate CLI — advisory verify-before-done. Runs the repo's
 * `.lane-verify.json` commands (test/lint) and records a verifier_verdict; NEVER blocks.
 *
 * Usage:
 *   node scripts/verify-gate.js [repoRoot] [--session <id>] [--files a,b] [--quiet]
 *
 * Opt-in: no-ops (exit 0) when the repo has no `.lane-verify.json`. Invoked manually,
 * from the deployer/verify path, or spawned detached by session-stop.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findConfig, shouldRun, runGate, ANY_FILE } = require('./_lib/verify-gate');

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function realRunner(command, { cwd, timeoutMs }) {
  // shell:true because `.lane-verify.json` commands are shell strings ("npm test
  // && npm run lint"). The config is repo-owned and git-tracked — same trust level
  // as an npm script — so it is not an injection boundary. Never pass user input here.
  const r = spawnSync(command, { cwd, timeout: timeoutMs, shell: true, stdio: 'ignore' });
  return { code: r.status == null ? 1 : r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

function main() {
  const repoRoot = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd());
  const quiet = process.argv.includes('--quiet');
  const config = findConfig(repoRoot);
  if (!config) { if (!quiet) console.log('verify-gate: no .lane-verify.json — skipped (opt-in).'); return; }

  const sessionId = flag('--session');
  const filesArg = flag('--files');
  const filesTouched = filesArg ? filesArg.split(',').map((s) => s.trim()).filter(Boolean) : [ANY_FILE];
  if (!shouldRun(config, filesTouched, repoRoot)) {
    if (!quiet) console.log('verify-gate: no matching changed paths — skipped.');
    return;
  }

  if (!quiet) console.log(`verify-gate: running ${config.commands.length} command(s) in ${repoRoot}...`);
  const result = runGate(repoRoot, config, realRunner);

  // Record a verifier verdict (advisory) — same channel the pre-PR gate uses, so it
  // shows on the dashboards and never fabricates a PASS.
  try {
    const { logValueEvent } = require('./hooks/value-logger');
    logValueEvent('verifier_verdict', result.verdict === 'PASS' ? 1 : 0, {
      taskId: `verify-gate:${path.basename(repoRoot)}`,
      verdict: result.verdict, panel: 'verify-gate', panelists: 1,
      passVotes: result.verdict === 'PASS' ? 1 : 0,
      blockers: result.verdict === 'PASS' ? 0 : result.failed.length,
      retry: 0, project: path.basename(repoRoot), source: 'verify-gate',
      failed: result.failed,
    }, sessionId);
  } catch { /* recording is best-effort */ }

  if (!quiet) {
    console.log(`verify-gate: ${result.verdict}` +
      (result.failed.length ? ` — failed: ${result.failed.join(', ')}` : ` (${result.ran} command(s) passed)`));
    if (result.verdict === 'FAIL') console.log('  (advisory — not blocking; fix before merging)');
  }
  // Advisory: always exit 0 so nothing downstream treats this as a hard gate.
}

if (require.main === module) main();

module.exports = { realRunner };
