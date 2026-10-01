#!/usr/bin/env node
/* eslint-disable no-empty */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { atomicWrite } = require('../_lib/process');

const STALE_LOCK_AGE_MS = 30_000;
const STALE_LOCK_LOG = '.ai-memory/stale-lock-cleanup.jsonl';

// Auto-import team memory: merge teammates' committed observation chunks into the
// local store so `mem_search` sees them. Change-detected via a cheap signature so it
// only runs when chunks actually changed; idempotent (dedups by id). Best-effort —
// never blocks or breaks session start.
async function autoImportMemory(root) {
  try {
    const { importChunks, signatureOf } = require('../memory-export');
    const sig = signatureOf(root);
    if (!sig) return;
    const sigPath = path.join(root, '.ai-memory', 'observations', '.import-sig');
    let last = '';
    try { last = fs.readFileSync(sigPath, 'utf8'); } catch {}
    if (sig === last) return;
    importChunks(root);
    await fsp.mkdir(path.dirname(sigPath), { recursive: true });
    await atomicWrite(sigPath, sig);
  } catch { /* never break session start */ }
}

// Cursor's gitWorker.js and the session-stop hook's git add/commit can race,
// leaving an orphaned `.git/index.lock` (always 0 bytes, no surviving owner)
// that blocks every subsequent git operation until manually removed. Sweep
// 0-byte locks older than 30s on session start — newer ones might be a real
// in-flight git operation we shouldn't disturb.
async function sweepStaleLocks(root) {
  const cleaned = [];
  const candidates = [path.join(root, '.git', 'index.lock')];
  for (const lockPath of candidates) {
    try {
      const st = fs.statSync(lockPath);
      if (st.size !== 0) continue;
      if (Date.now() - st.mtimeMs < STALE_LOCK_AGE_MS) continue;
      fs.unlinkSync(lockPath);
      cleaned.push({ path: path.relative(root, lockPath), mtime_ms: st.mtimeMs });
    } catch { /* missing lock or unlink race — fine, ignore */ }
  }
  if (cleaned.length > 0) {
    try {
      const logPath = path.join(root, STALE_LOCK_LOG);
      await fsp.mkdir(path.dirname(logPath), { recursive: true });
      const entry = JSON.stringify({ ts: new Date().toISOString(), cleaned }) + '\n';
      await fsp.appendFile(logPath, entry);
    } catch { /* log failure is non-fatal */ }
  }
}

async function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  if (!raw) {
    try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch {}
  }
  if (!raw) return;

  let sessionId = '';
  try { sessionId = (JSON.parse(raw).session_id || '').trim(); } catch {}

  if (!sessionId) return;

  // TODO: stop writing this once consumers (audit logs, dashboards) confirmed not reading.
  // Phase 5 deletes .ai-session/cc-session-id from the repo and gitignores it (AC-26),
  // but session-start.js still writes it locally for legacy consumers.
  const aiSessionDir = path.join(process.cwd(), '.ai-session');
  const ccSessionFile = path.join(aiSessionDir, 'cc-session-id');
  await fsp.mkdir(aiSessionDir, { recursive: true });
  await atomicWrite(ccSessionFile, sessionId);

  // Clear cross-session project cache so a fresh CC session does not inherit
  // a project from a previous session's cwd/prompt detection. The cache gets
  // re-populated on the first prompt that detects a project from cwd/skill/
  // prompt sources, so legitimate work in a project dir still attributes
  // correctly — but a workspace-root session that never names a project
  // stays "unspecified" instead of latching onto the previous session's pick.
  const detectedProject = path.join(aiSessionDir, 'detected-project');
  try { await fsp.unlink(detectedProject); } catch {}

  await sweepStaleLocks(process.cwd());
  // Same root session-stop exports to (LANE_EVENTS_ROOT, set in settings.json), or the
  // session cwd. Importing into a different root than we export from would leave a
  // session under agent/_projects/<project> importing into that repo.
  await autoImportMemory(process.env.LANE_EVENTS_ROOT || process.cwd());
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
