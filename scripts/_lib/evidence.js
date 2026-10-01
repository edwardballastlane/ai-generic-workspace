'use strict';

/**
 * evidence — pure core for evidence-based completion.
 *
 * A "done" claim should cite captured machine evidence, not a model assertion.
 * This hashes a captured command artifact and verifies later that (a) the artifact
 * is byte-identical (sha256), (b) the command exited 0, and (c) the claimed
 * assertion substring is actually present in the output. Checking content and not
 * just the exit code is what catches a command that exits 0 having done nothing.
 * Pure; the CLIs do the running + I/O.
 */

const crypto = require('node:crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Build an evidence record from a captured command run.
 * @param {{taskId, criterionId, command, exitCode, output, assertion?, project?}} p
 */
// Stand-in exit code for "the command's outcome is not knowable" (signal kill, a
// caller that omitted it). Non-zero so verifyRecord rejects the record.
const UNKNOWN_EXIT = -1;

function buildRecord(p) {
  const output = String(p.output == null ? '' : p.output);
  return {
    taskId: String(p.taskId || ''),
    criterionId: String(p.criterionId || ''),
    command: String(p.command || ''),
    // Fail CLOSED. `p.exitCode | 0` would coerce null/undefined to 0, i.e. "passed" —
    // the wrong default in an anti-forgery core, and null is exactly what spawnSync
    // reports for a command killed by a signal (timeout, OOM). An unknown outcome is
    // recorded as a failure, so it can never certify a criterion.
    exitCode: Number.isInteger(p.exitCode) ? p.exitCode : UNKNOWN_EXIT,
    sha256: sha256(Buffer.from(output, 'utf8')),
    bytes: Buffer.byteLength(output, 'utf8'),
    assertion: String(p.assertion || ''),
    project: String(p.project || ''),
  };
}

/**
 * Verify a record against the artifact's CURRENT content.
 * @returns {{ok:boolean, errors:string[]}}
 */
function verifyRecord(record, artifactText) {
  const errors = [];
  const text = String(artifactText == null ? '' : artifactText);
  if (sha256(Buffer.from(text, 'utf8')) !== record.sha256) {
    errors.push('sha256 mismatch — the cited artifact changed since capture (evidence is stale/forged)');
  }
  if (record.exitCode !== 0) {
    errors.push(`command exited non-zero (${record.exitCode})`);
  }
  if (record.assertion && !text.includes(record.assertion)) {
    errors.push(`assertion not found in output: "${record.assertion}" (a hollow green — e.g. 0 tests collected — is rejected)`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { sha256, buildRecord, verifyRecord, UNKNOWN_EXIT };
