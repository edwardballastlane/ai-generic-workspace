#!/usr/bin/env node
'use strict';

/**
 * record-verdict — append a `verifier_verdict` value-event.
 *
 * Called by /swarm-implement Step 4.5 (the consensus gate) once a task's
 * verification panel has been tallied, so the gate's own PASS/FAIL history
 * becomes queryable. `scripts/gate-theater-report.js` reads these back to
 * flag rubber-stamping (see docs/specs/spec-2026-08-03-anti-rubber-stamp-gate.md).
 *
 * Usage:
 *   node scripts/record-verdict.js \
 *     --task T-3 --verdict PASS --panel generic \
 *     --panelists 3 --pass 3 --blockers 0 --retry 0 \
 *     --project my-project [--session <id>]
 */

const path = require('node:path');

// value-logger resolves the workspace root by walking up for a CLAUDE.md. Any
// nested CLAUDE.md below the real root (e.g. one placed in scripts/hooks/) would
// stop that walk early and write the log to the wrong place. Pin the real root
// (parent of scripts/) before requiring it, unless the caller already set one
// (tests do).
if (!process.env.WORKSPACE_ROOT) {
  process.env.WORKSPACE_ROOT = path.resolve(__dirname, '..');
}

const { logValueEvent } = require('./hooks/value-logger');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const { normalizeVerdict } = require('./_lib/verdict');
// Severity floor: a verdict must match its findings — a PASS beside a blocker
// upgrades to FAIL; a FAIL with no blocker/major floors to PASS. Raw token preserved.
const blockers = Number(arg('blockers', '0')) || 0;
const norm = normalizeVerdict({ verdict: arg('verdict', 'PASS'), blockers, majors: Number(arg('majors', '0')) || 0 });

const details = {
  taskId: arg('task', 'unknown'),
  verdict: norm.verdict,
  verdictRaw: norm.raw,
  verdictNormalized: norm.normalized,
  panel: arg('panel', 'generic'),
  panelists: Number(arg('panelists', '0')) || 0,
  passVotes: Number(arg('pass', '0')) || 0,
  blockers: blockers,
  retry: Number(arg('retry', '0')) || 0,
  project: arg('project', 'unknown'),
  // Effective model that actually produced this verdict. Honest
  // three-state: the caller's --model, else 'unknown' — NEVER backfilled with an
  // assumed/configured id, so the audit trail can't silently misattribute.
  effectiveModel: arg('model', 'unknown'),
};

logValueEvent('verifier_verdict', 1, details, arg('session', ''));
const rawNote = norm.normalized ? ` (raw: ${norm.raw} — ${norm.reason})` : '';
process.stdout.write(`recorded verdict ${details.verdict} for ${details.taskId} (panel=${details.panel}, blockers=${details.blockers})${rawNote}\n`);
