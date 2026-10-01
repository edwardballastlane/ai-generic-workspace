#!/usr/bin/env node
'use strict';

/**
 * record-evidence — run a verification command, capture its output as a hashed
 * artifact, and log a `completion_evidence` event so a "done" claim cites machine
 * evidence per acceptance criterion.
 *
 * Usage:
 *   node scripts/record-evidence.js --task T-3 --criterion AC-2 \
 *     --assert "3 passed" --project my-proj -- npx jest currency.spec.ts
 *
 * Artifacts: .ai-memory/evidence/<task>/<criterion>.log (local, ephemeral).
 * Exit code mirrors the wrapped command so callers can gate on it too.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildRecord } = require('./_lib/evidence');

if (!process.env.WORKSPACE_ROOT) process.env.WORKSPACE_ROOT = path.resolve(__dirname, '..');
const { logValueEvent } = require('./hooks/value-logger');
const ROOT = process.env.WORKSPACE_ROOT;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const dashdash = process.argv.indexOf('--');
if (dashdash === -1 || !process.argv[dashdash + 1]) {
  console.error('usage: record-evidence.js --task <id> --criterion <id> [--assert <substr>] [--project <p>] -- <command...>');
  process.exit(2);
}
const cmd = process.argv.slice(dashdash + 1);
const taskId = arg('task', 'unknown');
const criterionId = arg('criterion', 'unknown');

const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
const output = (r.stdout || '') + (r.stderr || '');
const exitCode = r.status == null ? 1 : r.status;

const dir = path.join(ROOT, '.ai-memory', 'evidence', taskId);
fs.mkdirSync(dir, { recursive: true });
const artifact = path.join('.ai-memory', 'evidence', taskId, `${criterionId}.log`);
fs.writeFileSync(path.join(ROOT, artifact), output);

const record = buildRecord({ taskId, criterionId, command: cmd.join(' '), exitCode, output, assertion: arg('assert', ''), project: arg('project', 'unknown') });
logValueEvent('completion_evidence', 1, { ...record, artifact }, arg('session', ''));

console.log(`recorded evidence for ${taskId}/${criterionId}: exit=${exitCode} bytes=${record.bytes} sha=${record.sha256.slice(0, 12)} → ${artifact}`);
process.exit(exitCode);
