'use strict';
/**
 * Refresh + publish the self-improvement dashboard snapshot.
 *
 * Regenerates the dashboard from full LOCAL data (Qdrant + session transcripts +
 * personal rules) and commits the result so CI and teammates pick it up. This is
 * the refresh mechanism for the local-only sections (sessions, reflections,
 * topics) that CI cannot rebuild — it falls back to this committed snapshot. See
 * the snapshot fallback in scripts/session-embedder/dashboard-generator.ts.
 *
 * Run this on a machine where Qdrant is up (otherwise the generator falls back to
 * the existing snapshot, nothing changes, and this exits as a no-op). Good fit
 * for a nightly local cron / launchd job.
 *
 * Usage:
 *   node scripts/self-dashboard-publish.js            # regenerate + commit + push
 *   node scripts/self-dashboard-publish.js --no-push  # regenerate + commit only
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const PUSH = !process.argv.includes('--no-push');

// The local-only data files that make up the committed snapshot. index.html is
// intentionally excluded — the deploy pipeline rebuilds it from dashboard.html
// (and combine-dashboards.js needs token-dashboard.html, which may be absent
// locally).
const FILES = [
  '.claude/visualizations/_self_sessions.jsonl',
  '.claude/visualizations/_self_reflections.jsonl',
  '.claude/visualizations/dashboard-data.json',
  '.claude/visualizations/topic-cache.json',
  '.claude/visualizations/dashboard.html',
];

function log(msg) { process.stdout.write(msg + '\n'); }

/** Best-effort Qdrant reachability check (warn-only). */
function qdrantReachable() {
  return new Promise(resolve => {
    try {
      const u = new URL(`${QDRANT_URL}/collections`);
      const req = http.request(
        { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname, timeout: 1500 },
        res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

async function main() {
  if (!(await qdrantReachable())) {
    log(`⚠  Qdrant not reachable at ${QDRANT_URL} — sessions/reflections/topics will`);
    log('   fall back to the existing snapshot (likely a no-op publish). Start Qdrant');
    log('   (docker compose up -d) to capture fresh local data.');
  }

  // 1a. Backfill the file-backed metrics (sessions/reflections) from local Qdrant
  //     so the committed JSONL — which the dashboard reads — is current. Skipped
  //     implicitly when Qdrant is down (scroll returns nothing → files unchanged).
  log('Backfilling file-backed metrics from Qdrant…');
  const bf = spawnSync(NPX, ['ts-node', 'scripts/session-embedder/self-metrics-backfill.ts'], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  if (bf.status !== 0) {
    log('⚠  Metrics backfill failed — keeping existing committed metrics and continuing.');
  }

  // 1b. Regenerate the dashboard (reads the metric files; writes dashboard-data.json
  //     + topic-cache.json + dashboard.html).
  log('Regenerating self-improvement dashboard…');
  const gen = spawnSync(NPX, ['ts-node', 'scripts/session-embedder/dashboard-generator.ts'], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  if (gen.status !== 0) {
    process.stderr.write('Dashboard generation failed — aborting publish.\n');
    process.exit(1);
  }

  // 2. Skip timestamp-only churn. Every generate bumps `generatedAt` (and the
  //    derived `snapshot.asOf`), so a raw diff is never empty. Compare the
  //    regenerated data with those volatile fields normalized out — only a real
  //    data change should produce a commit (critical for a nightly cron).
  const DATA_FILE = '.claude/visualizations/dashboard-data.json';
  const normalize = (jsonText) => {
    const d = JSON.parse(jsonText);
    delete d.generatedAt;
    delete d.snapshot;
    return JSON.stringify(d);
  };
  let committedData = null;
  try { committedData = execFileSync('git', ['show', `HEAD:${DATA_FILE}`], { cwd: ROOT, encoding: 'utf8' }); } catch { /* not tracked yet */ }
  if (committedData) {
    try {
      const fresh = fs.readFileSync(path.join(ROOT, DATA_FILE), 'utf8');
      if (normalize(committedData) === normalize(fresh)) {
        log('No data changes since last publish (timestamp-only diff) — nothing to publish.');
        try { execFileSync('git', ['checkout', 'HEAD', '--', ...FILES], { cwd: ROOT, stdio: 'ignore' }); } catch {}
        process.exit(0);
      }
    } catch { /* fall through to normal staging if comparison fails */ }
  }

  // 3. Stage + commit the real change.
  try {
    execFileSync('git', ['add', '--', ...FILES], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    process.stderr.write('Not a git repository (or git unavailable) — cannot publish.\n');
    process.exit(1);
  }
  let changed = true;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet', '--', ...FILES], { cwd: ROOT, stdio: 'ignore' });
    changed = false;
  } catch { changed = true; }

  if (!changed) {
    log('Snapshot unchanged — nothing to publish.');
    process.exit(0);
  }

  execFileSync('git', [
    'commit', '--no-verify',
    '-m', 'chore(self-dashboard): refresh data snapshot',
    '--', ...FILES,
  ], { cwd: ROOT, stdio: 'inherit' });
  log('Committed refreshed snapshot.');

  // 4. Push (default). Pushes the current branch; on master this triggers the
  //    deploy pipeline, which republishes the dashboard to S3.
  if (!PUSH) {
    log('Skipped push (--no-push). To publish: git push origin <branch>');
    return;
  }
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  execFileSync('git', ['push', 'origin', branch], { cwd: ROOT, stdio: 'inherit' });
  log(`Pushed to origin/${branch}.`);
}

main().catch(err => {
  process.stderr.write(`self-dashboard-publish failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
