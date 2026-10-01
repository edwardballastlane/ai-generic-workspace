'use strict';

/**
 * Learning-health check for the self-improvement pipeline.
 *
 * Sessions are embedded into Qdrant on every session-stop, but insight
 * extraction (sessions → rules) only runs on a manual `npm run self:maintenance`.
 * So embedded sessions can silently pile up, never becoming rules. This module
 * surfaces that staleness and — when it crosses a threshold — auto-triggers a
 * lightweight extraction in the background.
 *
 * Two surfaces share this logic:
 *   - scripts/hooks/session-stop.js  (background, gated by a cooldown)
 *   - .claude/commands/pre-push.md   (visible status line, never blocks a push)
 *     via the CLI:  node scripts/_lib/learning-health.js --status | --check
 *
 * The *check* is file-based (events log + rules.json + a state file) so it always
 * works. Only the *trigger* needs Qdrant (extraction reads session-embeddings),
 * so it is gated on Qdrant reachability exactly like the embedder.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { atomicWrite, spawnDetached } = require('./process');
const { listEventFiles } = require('./session-events');

const STALE_SESSIONS = Number(process.env.LEARNING_STALE_SESSIONS || 10);
const STALE_DAYS = Number(process.env.LEARNING_STALE_DAYS || 7);
const COOLDOWN_HOURS = Number(process.env.LEARNING_COOLDOWN_HOURS || 12);
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const DAY_MS = 86400000;

function findWorkspaceRoot(start) {
  let current = start || process.cwd();
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function statePath(root) { return path.join(root, '.claude', 'logs', 'learning-state.json'); }
function logPath(root) { return path.join(root, '.claude', 'logs', 'learning.log'); }
function rulesPath(root) { return path.join(root, 'scripts', 'self-improvement', 'rules.json'); }

function readState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return {}; }
}

async function writeState(root, state) {
  try {
    await fsp.mkdir(path.dirname(statePath(root)), { recursive: true });
    await atomicWrite(statePath(root), JSON.stringify(state, null, 2) + '\n');
  } catch { /* never block the caller */ }
}

function readRulesSummary(root) {
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath(root), 'utf8'));
    const active = rules.filter(r => r.status === 'active');
    const proposed = rules.filter(r => r.status === 'proposed');
    const newest = rules
      .map(r => r.createdAt)
      .filter(Boolean)
      .sort()
      .pop() || null;
    return { activeRules: active.length, pendingProposals: proposed.length, newestRuleAt: newest };
  } catch {
    return { activeRules: 0, pendingProposals: 0, newestRuleAt: null };
  }
}

/**
 * Count distinct sessions recorded after `sinceIso` across the legacy archive
 * and every monthly shard. Files are bounded (one month each) so a plain read
 * stays cheap.
 */
async function countSessionsSince(root, sinceIso) {
  const sessions = new Set();
  for (const file of listEventFiles(root)) {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let row;
      try { row = JSON.parse(t); } catch { continue; }
      const ts = row.ts || '';
      if (sinceIso && !(ts > sinceIso)) continue; // ISO strings sort lexically
      if (row.session_id) sessions.add(row.session_id);
    }
  }
  return sessions.size;
}

/**
 * Full, file-based health snapshot. Always safe to call.
 */
async function getLearningHealth(root) {
  const r = root || findWorkspaceRoot();
  const state = readState(r);
  const lastExtractionAt = state.lastExtractionAt || null;
  const { activeRules, pendingProposals, newestRuleAt } = readRulesSummary(r);

  // Reference point for "since": our extraction watermark if we have one, else
  // the newest rule's creation date (best proxy for the last time the pipeline
  // produced something). Keeps the session count and the day count consistent.
  const refIso = lastExtractionAt || newestRuleAt;
  const sessionsSinceExtraction = await countSessionsSince(r, refIso);
  const daysSinceExtraction = refIso
    ? (Date.now() - new Date(refIso).getTime()) / DAY_MS
    : Infinity;

  const reasons = [];
  if (sessionsSinceExtraction >= STALE_SESSIONS) {
    reasons.push(`${sessionsSinceExtraction} sessions since last extraction (≥${STALE_SESSIONS})`);
  }
  if (daysSinceExtraction >= STALE_DAYS) {
    const d = daysSinceExtraction === Infinity ? 'never run' : `${daysSinceExtraction.toFixed(0)}d ago`;
    reasons.push(`last extraction ${d} (≥${STALE_DAYS}d)`);
  }

  return {
    sessionsSinceExtraction,
    daysSinceExtraction,
    activeRules,
    pendingProposals,
    lastExtractionAt,
    isStale: reasons.length > 0,
    reasons,
  };
}

function isReachable(url, timeoutMs) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function appendLog(root, message) {
  try {
    await fsp.mkdir(path.dirname(logPath(root)), { recursive: true });
    await fsp.appendFile(logPath(root), `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* ignore */ }
}

/**
 * Spawn `self:extract-insights` detached, logging to learning.log.
 */
function spawnExtraction(root) {
  let fd = 'ignore';
  try { fd = fs.openSync(logPath(root), 'a'); } catch { fd = 'ignore'; }
  spawnDetached(NPX_BIN, [
    '--no-install', 'ts-node',
    'scripts/self-improvement/insight-extractor.ts',
  ], {
    cwd: root,
    stdio: typeof fd === 'number' ? ['ignore', fd, fd] : 'ignore',
  });
}

/**
 * Decide whether to run extraction, and run it (detached) if so.
 *
 * Gating: a cooldown short-circuits the expensive scan, so the heavy extraction
 * fires at most once per COOLDOWN_HOURS even across a burst of sessions.
 *
 * @returns {Promise<{triggered: boolean, reason: string, health?: object}>}
 */
async function maybeTriggerExtraction(root, opts = {}) {
  const r = root || findWorkspaceRoot();
  const state = readState(r);

  const lastTriggerAt = state.lastTriggerAt ? new Date(state.lastTriggerAt).getTime() : 0;
  const hoursSinceTrigger = (Date.now() - lastTriggerAt) / 3600000;
  if (lastTriggerAt && hoursSinceTrigger < COOLDOWN_HOURS) {
    return { triggered: false, reason: `cooldown (${hoursSinceTrigger.toFixed(1)}h < ${COOLDOWN_HOURS}h)` };
  }

  const health = await getLearningHealth(r);
  if (!health.isStale) {
    return { triggered: false, reason: 'fresh', health };
  }

  const qdrantOk = await isReachable(`${QDRANT_URL}/collections`, 1000);
  if (!qdrantOk) {
    await appendLog(r, `stale (${health.reasons.join('; ')}) but Qdrant unreachable — not extracting`);
    return { triggered: false, reason: 'qdrant-unreachable', health };
  }

  const nowIso = new Date().toISOString();
  await writeState(r, { ...state, lastTriggerAt: nowIso, lastExtractionAt: nowIso });
  await appendLog(r, `triggering extraction — ${health.reasons.join('; ')}`);
  spawnExtraction(r);

  return { triggered: true, reason: health.reasons.join('; '), health };
}

function formatStatusLine(health) {
  const days = health.daysSinceExtraction === Infinity
    ? 'never'
    : `${health.daysSinceExtraction.toFixed(0)}d ago`;
  const head = health.isStale ? '⚠ learning stale' : '✓ learning fresh';
  return `${head}: ${health.sessionsSinceExtraction} sessions since last extraction (${days}), `
    + `${health.activeRules} active rules, ${health.pendingProposals} proposals pending`
    + (health.isStale ? ` — ${health.reasons.join('; ')}` : '');
}

async function cli() {
  const root = findWorkspaceRoot();
  const mode = process.argv.includes('--check') ? 'check' : 'status';
  const health = await getLearningHealth(root);
  process.stdout.write(formatStatusLine(health) + '\n');

  if (mode === 'check') {
    const res = await maybeTriggerExtraction(root);
    if (res.triggered) {
      process.stdout.write('→ extraction triggered in background (see .claude/logs/learning.log)\n');
    } else if (res.reason === 'qdrant-unreachable') {
      process.stdout.write('→ stale, but Qdrant is down — run `npm run self:maintenance` when it is back up\n');
    } else if (res.reason.startsWith('cooldown')) {
      process.stdout.write(`→ extraction skipped (${res.reason})\n`);
    }
  } else if (health.isStale) {
    process.stdout.write('→ run `npm run self:maintenance` to turn these sessions into rules\n');
  }
}

if (require.main === module) {
  cli().then(() => process.exit(0)).catch(() => process.exit(0));
}

module.exports = {
  getLearningHealth,
  maybeTriggerExtraction,
  formatStatusLine,
  findWorkspaceRoot,
};
