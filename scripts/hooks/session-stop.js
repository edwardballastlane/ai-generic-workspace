#!/usr/bin/env node
/* eslint-disable no-empty */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const { readTranscript } = require('../_lib/transcript');
const { computeCostUsd } = require('../_lib/cost');
const { atomicWrite, spawnDetached } = require('../_lib/process');
const { rotateIfTooLarge } = require('../_lib/log-rotate');
const { deriveTaskSummary, extractJiraTicket, getGitUser } = require('../_lib/heuristics');
const { maybeTriggerExtraction } = require('../_lib/learning-health');
const { currentShardPath } = require('../_lib/session-events');

// Canonical logging root. Defaults to the session's cwd (unchanged behavior), but
// LANE_EVENTS_ROOT lets a hook fired from ANY directory (e.g. another repo whose
// settings.local.json points here) write/commit/push its session events into one
// canonical clone — the one the token dashboard reads. Without this, sessions
// launched outside this repo log into their own cwd's .ai-memory (or nowhere) and
// never reach the dashboard. See docs/specs/spec-2026-06-24-centralized-session-logging.md.
const ROOT = process.env.LANE_EVENTS_ROOT || process.cwd();
const EVENTS_DIR = path.join(ROOT, '.ai-memory');
const SIDECAR_DIR = path.join(ROOT, '.ai-session', 'by-id');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// child_process.spawn without shell:true won't resolve .cmd shims on Windows.
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    // Safety: 1s cap so a stuck stdin doesn't hold the hook past its timeout.
    setTimeout(() => resolve(data), 1000).unref();
  });
}

function deriveSessionId(payload, transcriptPath) {
  if (payload.session_id) return payload.session_id;
  if (transcriptPath) {
    const base = path.basename(transcriptPath, '.jsonl');
    if (UUID_RE.test(base)) return base;
  }
  return '';
}

/**
 * Mirrors `curl -fsS --max-time 1 -o /dev/null "$QDRANT_URL/collections"` from
 * session-stop.sh:253 — used to gate the embedder spawn on Qdrant reachability.
 * Resolves to true on any 2xx-4xx response, false on connection error / timeout.
 * Never throws.
 */
async function isReachable(urlString, timeoutMs) {
  const isHttps = urlString.startsWith('https:');
  const { request } = isHttps ? https : http;
  return new Promise(resolve => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const u = new URL(urlString);
      const req = request({
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: (u.pathname || '/') + (u.search || ''),
        timeout: timeoutMs
      }, res => {
        res.resume();
        done(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => done(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} ; done(false); });
      req.end();
    } catch { done(false); }
    setTimeout(() => done(false), timeoutMs + 100).unref();
  });
}

/**
 * Builds the session_end event object from sidecar (if available) or heuristics.
 */
async function buildEvent({ sidecar, sidecarPath, t, taskFb, taskSourceFb, jiraFb, gitUser, ts, effectiveSessionId, computedCostUsd }) {
  if (sidecar) {
    const existingCost = Number(sidecar.cost_usd || 0);
    const sidecarHasTask = !!(sidecar.task && sidecar.task.length > 0);
    const event = {
      type: 'session_end',
      ts,
      session_id: sidecar.session_id,
      project: sidecar.project || 'unknown',
      task: sidecarHasTask ? sidecar.task : taskFb,
      task_source: sidecarHasTask ? (sidecar.task_source || 'sidecar') : taskSourceFb,
      jira_ticket: (sidecar.jira_ticket && sidecar.jira_ticket.length > 0)
        ? sidecar.jira_ticket : jiraFb,
      user: gitUser,
      prompts: sidecar.prompts || 0,
      model: t.model || '',
      cost_usd: existingCost > 0 ? existingCost : computedCostUsd,
      duration_ms: sidecar.duration_ms || 0,
      input_tokens: t.tokens.input,
      output_tokens: t.tokens.output,
      cache_read_tokens: t.tokens.cacheRead,
      cache_creation_tokens: t.tokens.cacheCreation,
      cache_creation_5m_tokens: t.tokens.cacheCreation5m || 0,
      cache_creation_1h_tokens: t.tokens.cacheCreation1h || 0,
      lines_added: sidecar.lines_added || 0,
      lines_removed: sidecar.lines_removed || 0,
      ai_estimated: sidecar.ai_estimated ?? null
    };

    // Backfill sidecar with token counts + computed cost (only when cost was 0).
    const updated = {
      ...sidecar,
      input_tokens: t.tokens.input,
      output_tokens: t.tokens.output,
      cache_read_tokens: t.tokens.cacheRead,
      cache_creation_tokens: t.tokens.cacheCreation,
      cache_creation_5m_tokens: t.tokens.cacheCreation5m || 0,
      cache_creation_1h_tokens: t.tokens.cacheCreation1h || 0
    };
    if (existingCost === 0) updated.cost_usd = computedCostUsd;
    try { await atomicWrite(sidecarPath, JSON.stringify(updated, null, 2)); } catch {}
    return event;
  }

  return {
    type: 'session_end',
    ts,
    session_id: effectiveSessionId,
    user: gitUser,
    task: taskFb,
    task_source: taskSourceFb,
    jira_ticket: jiraFb,
    model: t.model || '',
    cost_usd: computedCostUsd,
    input_tokens: t.tokens.input,
    output_tokens: t.tokens.output,
    cache_read_tokens: t.tokens.cacheRead,
    cache_creation_tokens: t.tokens.cacheCreation,
    cache_creation_5m_tokens: t.tokens.cacheCreation5m || 0,
    cache_creation_1h_tokens: t.tokens.cacheCreation1h || 0,
    lines_added: 0,
    lines_removed: 0,
    ai_estimated: null
  };
}

/**
 * Auto-commits the session-end events file, the value-events log, and (when
 * present) the Jira story-points cache. Best-effort and silent — non-repos and
 * unstaged states are skipped without erroring. The SP cache and value-events
 * log are added separately so they get committed whenever a prior session (or
 * the per-prompt value logger) has updated them; both are git-tracked with a
 * union merge driver so teammates pick them up on pull. value-events.jsonl
 * feeds the self-improvement dashboard's rule-injection/value sections.
 */
function autoCommit({ root, effectiveSessionId, gitUser }) {
  // Stage/commit the current month's shard, not the frozen legacy archive.
  const SESSION_EVENTS = path.posix.join('.ai-memory', path.basename(currentShardPath(root)));
  const SP_CACHE = '.ai-memory/jira-story-points.json';
  const VALUE_EVENTS = '.claude/logs/value-events.jsonl';
  const AI_ESTIMATES = '.ai-memory/ai-estimates.json';
  const MEMORY_EXPORT = '.ai-memory/observations-export';

  // Build the pathspec from files that actually exist. `git commit -- <path>`
  // aborts the ENTIRE commit if any listed path is unknown to git, so a fixed
  // list containing an absent file (e.g. no SP cache on a fresh clone, or no
  // value-events this session) would silently commit nothing.
  const pathspec = [];
  let isRepo = true;
  try {
    execFileSync('git', ['add', SESSION_EVENTS], { cwd: root, stdio: 'ignore' });
    pathspec.push(SESSION_EVENTS);
  } catch { isRepo = false; }
  if (!isRepo) return;

  // SP cache / value-events may not exist yet (fresh clone, no Jira creds, or
  // no value events logged this session). Stage + include each only when present.
  for (const rel of [SP_CACHE, VALUE_EVENTS, AI_ESTIMATES, MEMORY_EXPORT]) {
    try {
      if (fs.existsSync(path.join(root, rel))) {
        execFileSync('git', ['add', rel], { cwd: root, stdio: 'ignore' });
        pathspec.push(rel);
      }
    } catch {}
  }

  let hasStaged = false;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet', '--', ...pathspec],
      { cwd: root, stdio: 'ignore' });
  } catch {
    hasStaged = true;
  }

  if (hasStaged) {
    try {
      execFileSync('git', [
        'commit', '--no-verify',
        '-m', `chore: log session ${effectiveSessionId.slice(0, 8)} (${gitUser})`,
        '--', ...pathspec
      ], { cwd: root, stdio: 'ignore' });
    } catch {}
  }
}

/**
 * Best-effort, non-blocking push of the session-log commits autoCommit just made.
 * The hook commits session events locally, but the token/cost dashboard reads the
 * *pushed* file — so without this, a clone that falls behind (e.g. on a stale hook)
 * silently stops feeding the dashboard. Observed in the wild: a clone behind by
 * ~100 commits stopped reporting one user's sessions for ~2 weeks even though the
 * events were being committed locally.
 *
 * Guards keep it safe for everyone:
 *  - Only pushes when an upstream is configured AND the branch is ahead of it
 *    (skips fresh clones, CI/test tempdirs, and already-synced states).
 *  - Detached + unref'd (via spawnDetached) so it never blocks session exit and
 *    never throws.
 *  - A non-fast-forward rejection (another terminal pushed first) is harmless:
 *    the commit stays local and the next session's push carries it.
 *  - Opt out with SESSION_AUTOPUSH=0.
 *
 * Note: a behind clone IS pulled (`pull --rebase`) so concurrent terminals can
 * both land their commits. If that rebase conflicts it is aborted rather than
 * left in progress — a stranded rebase would hand the next session a detached
 * HEAD and a conflicted tree, so the working tree is always restored before we
 * give up and let the next session carry the commit.
 */
function autoPush({ root }) {
  if (process.env.SESSION_AUTOPUSH === '0') return;
  try {
    // Upstream must exist; @{u} throws when none is configured.
    execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: root, stdio: 'ignore' });
    // Only push when there's something to push.
    const ahead = execFileSync('git', ['rev-list', '--count', '@{u}..HEAD'],
      { cwd: root, encoding: 'utf8' }).trim();
    if (ahead === '0' || ahead === '') return;
  } catch { return; }
  // Stash any unstaged working-tree changes so rebase doesn't abort, then
  // pull --rebase to handle concurrent pushes from other terminals, then push.
  // Non-fast-forward failures are retried once; after that we give up silently
  // and let the next session carry the commit.
  try {
    const hasUnstaged = (() => {
      try {
        execFileSync('git', ['diff', '--quiet'], { cwd: root, stdio: 'ignore' });
        return false;
      } catch { return true; }
    })();
    if (hasUnstaged) execFileSync('git', ['stash', '--quiet'], { cwd: root, stdio: 'ignore' });
    try {
      execFileSync('git', ['pull', '--rebase', '--quiet'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['push', '--quiet'], { cwd: root, stdio: 'ignore' });
    } catch (err) {
      // A `pull --rebase` that hits a conflict leaves the clone stranded
      // mid-rebase on a detached HEAD. Swallowing that (as this used to) also
      // blocks the stash pop below, so the next session inherits a conflicted
      // tree plus an orphaned stash and every later session re-strands it.
      // Rebase state is disposable here — the branch ref still holds the
      // commits, so unwinding costs nothing and the push retries next session.
      abortInProgressRebase(root);
      throw err;
    } finally {
      if (hasUnstaged) {
        try { execFileSync('git', ['stash', 'pop', '--quiet'], { cwd: root, stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
}

/**
 * Unwinds a rebase left in progress by a failed `pull --rebase`, restoring the
 * branch and a clean working tree. No-op when no rebase is in flight.
 *
 * @param {string} root Repository root.
 */
function abortInProgressRebase(root) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'],
      { cwd: root, encoding: 'utf8' }).trim();
    const inProgress = ['rebase-merge', 'rebase-apply']
      .some(d => fs.existsSync(path.join(root, gitDir, d)));
    if (!inProgress) return;
    execFileSync('git', ['rebase', '--abort'], { cwd: root, stdio: 'ignore' });
  } catch {}
}

/**
 * Spawns detached child processes for transcript embedding (Qdrant-gated)
 * and memory-sync.
 */
/**
 * Advisory verify-before-done: run the repo's opt-in `.lane-verify.json` gate in the
 * background over the files this session touched, recording a verdict for the next
 * session to see. Never blocks exit and never fails Stop. Off with VERIFY_GATE_ENABLED=0.
 */
function spawnVerifyGate({ root, sidecar, sessionId }) {
  if (process.env.VERIFY_GATE_ENABLED === '0') return;
  try {
    const sessionState = require('../_lib/session-state');
    const files = sessionState.filesTouched(sidecar);
    if (files.length === 0) return;                       // nothing edited -> nothing to verify
    const gate = path.join(root, 'scripts', 'verify-gate.js');
    if (!fs.existsSync(gate)) return;
    const repoRoot = sessionState.activeWorktree(sidecar) || root;
    spawnDetached(process.execPath,
      [gate, repoRoot, '--session', sessionId || '', '--files', files.join(','), '--quiet'],
      { cwd: root });
  } catch { /* advisory - never break Stop */ }
}

async function spawnDetachedChildren({ root, transcriptPath, sessionId }) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const embedderTs = path.join(root, 'scripts', 'session-embedder', 'index.ts');
  if (fs.existsSync(embedderTs)) {
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    if (await isReachable(`${qdrantUrl}/collections`, 1000)) {
      try {
        spawnDetached(NPX_BIN, [
          '--no-install', 'ts-node',
          'scripts/session-embedder/index.ts', 'embed', transcriptPath, '--embed-only'
        ], { cwd: root });
      } catch {}
    }
  }

  const memorySyncTs = path.join(root, 'scripts', 'hooks', 'memory-sync.ts');
  if (process.env.MEMORY_SYNC_ENABLED !== '0' && fs.existsSync(memorySyncTs)) {
    try {
      spawnDetached(NPX_BIN, [
        '--no-install', 'ts-node', 'scripts/hooks/memory-sync.ts'
      ], {
        cwd: root,
        env: {
          ...process.env,
          TRANSCRIPT_PATH: transcriptPath,
          HOOK_SESSION_ID: sessionId
        }
      });
    } catch {}
  }
}

async function main() {
  await fsp.mkdir(EVENTS_DIR, { recursive: true }).catch(() => {});

  const raw = await readStdin();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}

  const transcriptPath = payload.transcript_path || '';
  const effectiveSessionId = deriveSessionId(payload, transcriptPath);

  const t = await readTranscript(transcriptPath);
  const computedCostUsd = computeCostUsd(t.model, t.tokens);

  const heuristicsDisabled = process.env.EVENTS_TASK_HEURISTIC_DISABLE === '1';
  const sidecarPath = effectiveSessionId
    ? path.join(SIDECAR_DIR, `${effectiveSessionId}.json`)
    : '';

  let sidecar = null;
  if (sidecarPath) {
    try { sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8')); } catch {}
  }

  const derived = heuristicsDisabled
    ? { task: '', source: '' }
    : deriveTaskSummary({
        userPrompts: t.userPrompts,
        sessionId: effectiveSessionId,
        startedAt: (sidecar && sidecar.started_at) || '',
        lastActive: (sidecar && sidecar.last_active) || '',
        rootDir: ROOT
      });
  const taskFb = derived.task;
  const taskSourceFb = derived.source;
  const jiraFb = heuristicsDisabled ? '' : extractJiraTicket(t.userPrompts);
  const gitUser = getGitUser();
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const event = await buildEvent({
    sidecar, sidecarPath, t, taskFb, taskSourceFb, jiraFb, gitUser, ts,
    effectiveSessionId, computedCostUsd
  });

  try {
    // Append to the current month's shard (not the frozen legacy file) so git
    // history stops bloating — see scripts/_lib/session-events.js.
    await fsp.appendFile(currentShardPath(ROOT), JSON.stringify(event) + '\n');
  } catch {}

  // Fallback session memory: if the agent did not already record a session summary
  // via the lane-memory MCP tool (mem_session_summary), leave a thin one so no
  // session goes untraced. Best-effort — never blocks or breaks Stop.
  try {
    if (effectiveSessionId && event.task) {
      const memoryStore = require('../_lib/memory-store');
      const { isNoiseSummary, inferProject } = require('../_lib/summary-quality');
      const { sessionSummaryId } = require('../_lib/pr-summary');
      const content = `Task: ${event.task}${jiraFb ? ` (${jiraFb})` : ''}\nSource: ${event.task_source || 'session-stop'}`;
      // A richer PR-time summary (source 'pr-create') under the same deterministic id
      // takes precedence — don't overwrite it with this thin one.
      const already = memoryStore.sessionObservations(ROOT, effectiveSessionId)
        .some((o) => o.type === 'session_summary');
      // Skip noise the task heuristic pulls in (internal prompt leaks, log-session
      // auto-commits, bare tickets, follow-ups, sensitive data). See summary-quality.js.
      const noise = isNoiseSummary({ type: 'session_summary', title: event.task, content });
      if (!already && !noise) {
        const project = (sidecar && sidecar.project) || inferProject({ title: event.task, content });
        memoryStore.saveObservation(ROOT, {
          type: 'session_summary',
          title: event.task,
          content,
          sessionId: effectiveSessionId,
          project,
          source: 'session-stop',
          local: true,
        }, { id: sessionSummaryId(effectiveSessionId) });
      }
    }
  } catch {}

  // Note: Jira story-points cache is owned by the Bitbucket pipeline
  // (master deploy step + daily scheduled `refresh-jira-cache` pipeline).
  // autoCommit below still stages jira-story-points.json passively, in case
  // someone runs `npm run jira:refresh` manually on a dev machine.

  // Auto-export team memory: publish this machine's locally-authored observations
  // to a per-user chunk so teammates inherit them via git (autoCommit stages the
  // export dir; autoPush ships it). Only local:true observations are written —
  // imported/migrated ones are never re-shared. Best-effort.
  try {
    const { exportChunk, defaultChunkName } = require('../memory-export');
    exportChunk(ROOT, defaultChunkName(ROOT));
  } catch {}

  autoCommit({ root: ROOT, effectiveSessionId, gitUser });
  autoPush({ root: ROOT });

  // Log rotation: cap embed.log + memory-sync.log at 512 KB → 256 KB.
  for (const name of ['embed.log', 'memory-sync.log']) {
    try { await rotateIfTooLarge(path.join(EVENTS_DIR, name), 524288, 262144); } catch {}
  }

  await spawnDetachedChildren({ root: ROOT, transcriptPath, sessionId: effectiveSessionId });

  // Advisory verify-before-done — background, opt-in, never blocks exit.
  spawnVerifyGate({ root: ROOT, sidecar, sessionId: effectiveSessionId });

  // Learning-health: if embedded sessions have piled up without being turned
  // into rules, trigger extraction in the background. Cooldown-gated so it
  // fires at most once per window; never blocks CC exit.
  try { await maybeTriggerExtraction(ROOT); } catch {}
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
