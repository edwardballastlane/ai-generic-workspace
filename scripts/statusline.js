#!/usr/bin/env node
'use strict';

// statusline.js — Claude Code status line generator (Node port).
//
// Cross-platform Node port of `scripts/statusline` (355 bash lines). Eliminates
// the dual `jq` invocations on the transcript by consuming `lastUsage` from
// `readTranscript()` (Phase 3 T1). Performance budget: <200 ms cold to first
// stdout byte (AC-12). DEBUG_STATUSLINE=1 logs `elapsed=<ms>` to stderr.
//
// Wired in `.claude/settings.json`:
//   "statusLine": { "type": "command", "command": "node ./scripts/statusline.js" }

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readTranscript } = require(path.join(__dirname, '_lib', 'transcript.js'));
const { atomicWrite } = require(path.join(__dirname, '_lib', 'process.js'));

const START = Date.now();

// AC-19: self-apply executable bit (idempotent on POSIX, no-op on Windows).
try { fs.chmodSync(__filename, 0o755); } catch { /* non-fatal */ }

// ROOT_DIR uses process.cwd() (matching scripts/hooks/session-stop.js:19) so the
// sidecar read/write is tied to the invoking workspace. CC always launches the
// status command from the workspace root via .claude/settings.json, so this
// matches the bash original's effective behavior while keeping tests hermetic.
const ROOT_DIR = process.cwd();
const SIDECAR_DIR = path.join(ROOT_DIR, '.ai-session', 'by-id');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AC-15 + AC-20: palette gating by NO_COLOR + platform. CC pipes stdout (so
// isTTY === false) but still renders ANSI escapes, so we do NOT gate on isTTY
// — matches bash original which always emitted ANSI codes regardless.
function pickColors() {
  if (process.env.NO_COLOR) {
    return {
      R: '', BRAND: '', HEALTHY: '', WARNING: '', CRITICAL: '', MUTED: '',
    };
  }
  const isLegacyWin = process.platform === 'win32' && !process.env.WT_SESSION;
  if (isLegacyWin) {
    // 16-color fallback for legacy cmd.exe / PowerShell ISE.
    return {
      R: '\x1b[0m',
      BRAND: '\x1b[33m',
      HEALTHY: '\x1b[32m',
      WARNING: '\x1b[1;33m',
      CRITICAL: '\x1b[1;31m',
      MUTED: '\x1b[2m',
    };
  }
  // 24-bit truecolor for macOS/Linux/Windows Terminal — Lane brand palette.
  return {
    R: '\x1b[0m',
    BRAND: '\x1b[38;2;249;115;22m',
    HEALTHY: '\x1b[38;2;16;185;129m',
    WARNING: '\x1b[1;38;2;245;158;11m',
    CRITICAL: '\x1b[1;38;2;239;68;68m',
    MUTED: '\x1b[38;2;136;136;136m',
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function deriveSessionId(payload) {
  const sid = (payload.session_id || '').trim();
  if (sid) return sid;
  const t = payload.transcript_path || '';
  if (!t) return '';
  const base = path.basename(t).replace(/\.jsonl$/, '');
  return UUID_RE.test(base) ? base : '';
}

function readSidecar(sessionId) {
  if (!sessionId) return { sidecarPath: '', data: {} };
  const sidecarPath = path.join(SIDECAR_DIR, `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    return { sidecarPath, data: JSON.parse(raw) || {} };
  } catch {
    return { sidecarPath: fs.existsSync(sidecarPath) ? sidecarPath : '', data: {} };
  }
}

function ctxMaxTokens(modelId, payload) {
  const env = process.env.CLAUDE_CTX_MAX_TOKENS;
  if (env && /^\d+$/.test(env)) return parseInt(env, 10);
  // CC hands us the real window in the payload (context_window.context_window_size);
  // trust it over a model-id substring guess — the id is identical for 200k and 1M Opus.
  const sz = payload?.context_window?.context_window_size;
  if (typeof sz === 'number' && sz > 0) return sz;
  return /1m/i.test(modelId || '') ? 1_000_000 : 200_000;
}

function autocompactPct() {
  const env = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  let v = env && /^\d+$/.test(env) ? parseInt(env, 10) : 80;
  if (v < 10) v = 10;
  if (v > 95) v = 95;
  return v;
}

function ctxTokensFromUsage(lastUsage) {
  if (!lastUsage) return 0;
  return (
    (lastUsage.input_tokens || 0) +
    (lastUsage.cache_creation_input_tokens || 0) +
    (lastUsage.cache_read_input_tokens || 0)
  );
}

// CC's own resident-context count, when present, is authoritative and matches /context.
// Falls back to summing current_usage, then to 0 so callers can use the transcript instead.
function ctxTokensFromPayload(payload) {
  const cw = payload?.context_window;
  if (!cw) return 0;
  if (typeof cw.total_input_tokens === 'number' && cw.total_input_tokens > 0) {
    return cw.total_input_tokens;
  }
  const u = cw.current_usage;
  if (u) {
    return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return 0;
}

function zoneFor(pct) {
  if (pct >= 85) return 'critical';
  if (pct >= 60) return 'warning';
  return 'healthy';
}

function shortModel(m) {
  if (!m) return 'claude';
  if (/fable/i.test(m))  return 'fable';
  if (/mythos/i.test(m)) return 'mythos';
  if (/opus/i.test(m))   return 'opus';
  if (/sonnet/i.test(m)) return 'sonnet';
  if (/haiku/i.test(m))  return 'haiku';
  // Strip leading "claude-" then truncate.
  const stripped = m.replace(/^claude-/, '');
  return stripped.length > 8 ? stripped.slice(0, 8) : stripped;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtTime(durationMs) {
  // Mirrors bash original: API duration formatted as "Hh Mm" / "Mm Ss" / "Ss".
  // Empty when duration is missing or 0.
  if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs <= 0) return '';
  let s = Math.floor(durationMs / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function fmtCost(c) {
  if (typeof c !== 'number' || !isFinite(c) || c <= 0) return '';
  return '$' + c.toFixed(2);
}

function pickGitTarget(project, cwd) {
  if (project && project !== 'null') {
    const linkedDir = path.join(ROOT_DIR, 'agent', '_projects', project);
    if (fs.existsSync(linkedDir)) return linkedDir;
  }
  return cwd || '';
}

function readGit(target) {
  if (!target) return { branch: '', diffStats: '' };
  let branch = '';
  try {
    branch = execFileSync('git', ['-C', target, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
  } catch { return { branch: '', diffStats: '' }; }
  if (!branch) branch = 'detached';

  let diffStats = '';
  try {
    const status = execFileSync('git', ['-C', target, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    let mod = 0, staged = 0, unt = 0;
    for (const line of status.split('\n')) {
      if (!line) continue;
      if (/^\?\?/.test(line)) unt++;
      else if (/^.M|^M/.test(line)) mod++;
      // Parsed against bash exact regexes — staged (^[MADR]) and modified
      // (^.M|^M) overlap on a single status line, mirroring the bash tally.
      if (/^[MADR]/.test(line)) staged++;
    }
    const parts = [];
    if (mod) parts.push(`~${mod}`);
    if (staged) parts.push(`+${staged}`);
    if (unt) parts.push(`?${unt}`);
    diffStats = parts.join(' ');
  } catch { /* leave diffStats empty */ }
  return { branch, diffStats };
}

// Surfaces a diverged-from-upstream clone before it goes silent for weeks.
// session-stop.js's autoPush() is best-effort and never pulls/rebases — if a
// clone falls behind, `git push` is rejected as non-fast-forward on every
// session and the local commits just pile up with no signal to the user
// (observed: ~40 commits / ~10 days before anyone noticed a user's sessions
// had stopped reaching the shared dashboard). Read-only and cheap (no fetch,
// no network) — just compares HEAD against the last-known upstream ref.
function readAheadBehind(target) {
  if (!target) return { ahead: 0 };
  try {
    execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: target, stdio: 'ignore', timeout: 1000,
    });
  } catch { return { ahead: 0 }; }
  try {
    const out = execFileSync('git', ['rev-list', '--count', '@{u}..HEAD'], {
      cwd: target, encoding: 'utf8', timeout: 1500,
    }).trim();
    const ahead = parseInt(out, 10);
    return { ahead: Number.isFinite(ahead) ? ahead : 0 };
  } catch { return { ahead: 0 }; }
}

function shouldWriteback(sidecarData, incomingCost) {
  if (typeof incomingCost !== 'number' || !isFinite(incomingCost)) return false;
  if (incomingCost <= 0) return false;
  const prev = typeof sidecarData.cost_usd === 'number' ? sidecarData.cost_usd : 0;
  return prev !== incomingCost;
}

async function writeSidecar(sidecarPath, sidecarData, incomingCost, payload, tokens) {
  const next = { ...sidecarData };
  next.cost_usd = incomingCost;
  if (typeof payload.cost?.total_duration_ms === 'number') {
    next.duration_ms = payload.cost.total_duration_ms;
  }
  // Lines: take max of existing vs incoming (bash uses `if $la > existing`).
  const la = payload.cost?.total_lines_added || 0;
  const lr = payload.cost?.total_lines_removed || 0;
  next.lines_added = Math.max(la, sidecarData.lines_added || 0);
  next.lines_removed = Math.max(lr, sidecarData.lines_removed || 0);
  // Token semantics match session-stop.sh: input_tokens = raw input ONLY
  // (excludes cache creation/read), cache_creation_tokens = billable-cache-write,
  // cache_read_tokens = read-from-cache, output_tokens = output.
  next.input_tokens = tokens.input;
  next.output_tokens = tokens.output;
  next.cache_creation_tokens = tokens.cacheCreation;
  next.cache_read_tokens = tokens.cacheRead;
  await atomicWrite(sidecarPath, JSON.stringify(next, null, 2));
}

function buildOutput(ctx) {
  const { C, segments } = ctx;
  const SEP = `${C.MUTED} · ${C.R}`;
  return segments.filter(Boolean).join(SEP);
}

function composeSegments(C, state) {
  const segs = [];
  if (state.zone === 'critical') segs.push(`${C.CRITICAL}COMPACT NOW${C.R}`);
  if (state.project) segs.push(`${C.BRAND}${state.project}${C.R}`);
  if (state.branch) {
    const b = state.branch.length > 30 ? state.branch.slice(0, 27) + '…' : state.branch;
    segs.push(state.diffStats ? `${C.MUTED}${b} ${state.diffStats}${C.R}` : `${C.MUTED}${b}${C.R}`);
  }
  if (state.aheadCount > 0) {
    const color = state.aheadCount >= 30 ? C.CRITICAL
                : state.aheadCount >= 10 ? C.WARNING
                : C.MUTED;
    segs.push(`${color}⇡${state.aheadCount}${C.R}`);
  }
  segs.push(`${C.MUTED}${state.modelShort}${C.R}`);
  if (state.timeStr) segs.push(`${C.MUTED}${state.timeStr}${C.R}`);
  if (state.ctxTokens > 0) {
    const color = state.zone === 'critical' ? C.CRITICAL
                : state.zone === 'warning'  ? C.WARNING
                : C.HEALTHY;
    segs.push(`${color}${state.ctxPct}%${C.R}`);
  }
  if (state.tokens.input > 0 || state.tokens.output > 0) {
    const inB = state.tokens.input + state.tokens.cacheCreation;
    segs.push(`${C.MUTED}↑${fmtTokens(inB)} ↓${fmtTokens(state.tokens.output)}${C.R}`);
  }
  segs.push(`${C.MUTED}${state.prompts}p${C.R}`);
  if (state.lessons > 0) segs.push(`${C.HEALTHY}${state.lessons}L${C.R}`);
  if (state.rulesInjected > 0 || state.memoriesSurfaced > 0) {
    const parts = [`${C.BRAND}r:${state.rulesInjected}${C.R}`];
    if (state.memoriesSurfaced > 0) parts.push(`${C.BRAND}m:${state.memoriesSurfaced}${C.R}`);
    if (state.semanticHits > 0) parts.push(`${C.HEALTHY}s:${state.semanticHits}${C.R}`);
    segs.push(parts.join(' '));
  }
  if (state.costStr) {
    const tier = state.costUsd >= 5 ? C.CRITICAL
              : state.costUsd >= 1 ? C.WARNING
              : C.HEALTHY;
    segs.push(`${tier}${state.costStr}${C.R}`);
  }
  if (state.sessionId) segs.push(`${C.MUTED}${state.sessionId.slice(-8)}${C.R}`);
  return segs;
}

async function main(rawStdin) {
  let payload = {};
  try { payload = JSON.parse(rawStdin || '{}') || {}; } catch { payload = {}; }

  const sessionId = deriveSessionId(payload);
  const cwd = payload.cwd || payload.workspace?.current_dir || '';
  const modelId = payload.model?.id || '';
  const modelDisplay = payload.model?.display_name || modelId;
  const incomingCost = Number(payload.cost?.total_cost_usd || 0);

  const { sidecarPath, data: sidecar } = readSidecar(sessionId);
  const project = sidecar.project || '';
  const prompts = Number(sidecar.prompts || 0);
  const lessons = Array.isArray(sidecar.lessons_captured) ? sidecar.lessons_captured.length : 0;
  const rulesInjected = Number(sidecar.rules_injected || 0);
  const memoriesSurfaced = Number(sidecar.memories_surfaced || 0);
  const semanticHits = Number(sidecar.semantic_cache_hits || 0);

  const transcriptPath = payload.transcript_path || '';
  const t = await readTranscript(transcriptPath);

  // CTX% from lastUsage (T1).
  const maxTok = ctxMaxTokens(modelId, payload);
  const pct = autocompactPct();
  const threshold = Math.floor(maxTok * pct / 100);
  const ctxTokens = ctxTokensFromPayload(payload) || ctxTokensFromUsage(t.lastUsage);
  let ctxPct = 0;
  if (threshold > 0 && ctxTokens > 0) {
    ctxPct = Math.floor(ctxTokens * 100 / threshold);
    if (ctxPct > 100) ctxPct = 100;
  }
  const zone = ctxTokens > 0 ? zoneFor(ctxPct) : 'healthy';

  // Sidecar write-back (only on cost change).
  if (sidecarPath && shouldWriteback(sidecar, incomingCost)) {
    try { await writeSidecar(sidecarPath, sidecar, incomingCost, payload, t.tokens); }
    catch { /* non-fatal — render the line anyway */ }
  }

  const gitTarget = pickGitTarget(project, cwd);
  const { branch, diffStats } = readGit(gitTarget);
  const { ahead: aheadCount } = readAheadBehind(gitTarget);

  const C = pickColors();
  const state = {
    zone, project, branch, diffStats, aheadCount,
    modelShort: shortModel(modelDisplay || modelId),
    timeStr: fmtTime(payload?.cost?.total_duration_ms),
    ctxTokens, ctxPct,
    tokens: t.tokens,
    prompts, lessons,
    rulesInjected, memoriesSurfaced, semanticHits,
    costUsd: incomingCost,
    costStr: fmtCost(incomingCost),
    sessionId,
  };
  const segments = composeSegments(C, state);
  const out = buildOutput({ C, segments });
  process.stdout.write(out + '\n');
}

// Skip the IIFE when this file is `require`d (e.g. by tests pulling helpers).
if (require.main === module) {
  (async () => {
    try {
      const raw = await readStdin();
      await main(raw);
    } catch (err) {
      // Never block CC's status line — emit an empty newline and exit 0.
      try { process.stdout.write('\n'); } catch { /* ignore */ }
      if (process.env.DEBUG_STATUSLINE === '1') {
        try { process.stderr.write(`statusline error: ${err && err.message}\n`); } catch { /* ignore */ }
      }
    } finally {
      if (process.env.DEBUG_STATUSLINE === '1') {
        try { process.stderr.write(`elapsed=${Date.now() - START}ms\n`); } catch { /* ignore */ }
      }
    }
  })();
}

module.exports = {
  pickColors, shortModel, fmtTokens, ctxMaxTokens, ctxTokensFromPayload, autocompactPct, zoneFor,
  readAheadBehind,
};
