#!/usr/bin/env node
'use strict';

/**
 * record-verification — one deterministic call for the verify-ticket skill to
 * make its result measurable team-wide. verify-ticket is where the checks
 * actually run, so it holds the real pass/fail summary — the honest source for
 * BOTH a verifier verdict AND completion evidence.
 *
 * Effects (all best-effort, never throws non-zero for logging failures):
 *   1. completion_evidence — hashes the check summary to an artifact
 *      (.ai-memory/evidence/<task>/verify-<mode>.log) + a value-event, so the
 *      "done" claim cites re-verifiable proof, not narration.
 *   2. verifier_verdict — records PASS/FAIL directly (works for staging mode,
 *      which has no PR-creation moment).
 *   3. sets sidecar verify_local|verify_staging = passed|failed AND
 *      pre_pr_verdict_recorded=<task> — so the post-tool-use PR-creation hook
 *      (the fallback recorder) SKIPS this ticket and we never double-count.
 *
 * Usage:
 *   node scripts/record-verification.js --task PROJ-123 --mode local \
 *     --verdict PASS --checks "8/8 checks passed" [--project api-service] [--session <id>]
 */

const fs = require('node:fs');
const path = require('node:path');

if (!process.env.WORKSPACE_ROOT) process.env.WORKSPACE_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.WORKSPACE_ROOT;
const { logValueEvent } = require('./hooks/value-logger');
const { buildRecord } = require('./_lib/evidence');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const taskId = String(arg('task', '')).trim();
const mode = String(arg('mode', 'local')).toLowerCase() === 'staging' ? 'staging' : 'local';
const verdict = String(arg('verdict', 'PASS')).toUpperCase().startsWith('PASS') ? 'PASS' : 'FAIL';
const checks = String(arg('checks', ''));
const project = String(arg('project', 'unknown'));
const sessionId = String(arg('session', ''));

if (!taskId) {
  console.error('usage: record-verification.js --task <TICKET> --mode local|staging --verdict PASS|FAIL --checks "<summary>" [--project P] [--session id]');
  process.exit(2);
}

const pass = verdict === 'PASS';

// 1) evidence — write the summary artifact + hashed record
const artifactRel = path.join('.ai-memory', 'evidence', taskId, `verify-${mode}.log`);
const summary = `verify-ticket ${mode} for ${taskId}\nverdict: ${verdict}\n${checks}\n`;
try {
  const abs = path.join(ROOT, artifactRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, summary);
  const rec = buildRecord({
    taskId, criterionId: `verify-ticket-${mode}`, command: `verify-ticket ${mode}`,
    exitCode: pass ? 0 : 1, output: summary, assertion: pass ? 'verdict: PASS' : '', project,
  });
  logValueEvent('completion_evidence', 1, { ...rec, artifact: artifactRel, mode }, sessionId);
} catch { /* best-effort */ }

// 2) verdict — record directly (covers staging, which has no PR-create trigger)
logValueEvent('verifier_verdict', 1, {
  taskId, verdict, panel: `verify-ticket-${mode}`, panelists: 1,
  passVotes: pass ? 1 : 0, blockers: pass ? 0 : 1, retry: 0, project, source: 'verify-ticket',
  // Effective model — honest three-state, never backfilled.
  effectiveModel: arg('model', 'unknown'),
}, sessionId);

// 3) sidecar — set gate status + dedup marker so the PR-creation hook won't re-record.
// Routed through the single sidecar I/O owner (no-ops if the sidecar doesn't exist yet).
if (sessionId) {
  try {
    const sessionState = require('./_lib/session-state');
    sessionState.updateSidecar(ROOT, sessionId, (s) => ({
      ...s,
      [mode === 'staging' ? 'verify_staging' : 'verify_local']: pass ? 'passed' : 'failed',
      pre_pr_verdict_recorded: taskId,
    })).catch(() => {});
  } catch { /* best-effort */ }
}

console.log(`record-verification: ${taskId} ${mode} -> ${verdict} (evidence + verdict recorded${sessionId ? ', sidecar marked' : ''})`);
