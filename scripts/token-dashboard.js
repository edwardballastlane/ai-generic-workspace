#!/usr/bin/env node
'use strict';

// Generates the token-consumption dashboard from .ai-memory/session-end-events.jsonl.
// Replaces scripts/token-dashboard.sh (bash + Python heredoc + HTML heredoc) with one
// Node module so the master deploy step no longer forks python3 for math.
//
// Usage:
//   node scripts/token-dashboard.js              # write JSON + HTML, open browser
//   node scripts/token-dashboard.js --json-only  # write JSON only

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadDotEnv } = require('./_lib/load-dotenv');
const { loadSpCache, spCachePath, loadPeriodCache, periodCachePath, fetchDeliveredTickets } = require('./_lib/jira-story-points');
const { loadAiEstimates: loadAiEstimatesCache, aiEstimatesPath } = require('./_lib/ai-estimates');
const { loadTeamConfig } = require('./_lib/team-config');
const { readAllEvents, listEventFiles } = require('./_lib/session-events');
const { loadUserAliases, canonicalUser } = require('./_lib/user-aliases');
const { computeCostUsd } = require('./_lib/cost');

// Root resolution mirrors bash (script-dir / .. / .ai-memory) but allows tests
// to redirect via TOKEN_DASHBOARD_ROOT — without it, integration tests would
// have to overwrite the workspace's real events file.
const SCRIPT_DIR = __dirname;
const ROOT_DIR = process.env.TOKEN_DASHBOARD_ROOT || path.dirname(SCRIPT_DIR);
const OUTPUT_DIR = path.join(ROOT_DIR, '.claude', 'visualizations');
const DATA_FILE = path.join(OUTPUT_DIR, 'token-data.json');
const HTML_FILE = path.join(OUTPUT_DIR, 'token-dashboard.html');

// ── Pricing ───────────────────────────────────────────────────────────────
// Pricing is single-sourced from scripts/_lib/cost.js (the same table the
// session-stop hook and statusline use), so the dashboard view can never drift
// from the write-time numbers — the divergence that let Opus 4.8 be priced as
// Sonnet. `modelFamily` below is kept ONLY for grouping/labels in the by-model
// table, not for pricing.
const FAMILIES = ['fable', 'opus', 'opus_legacy', 'sonnet', 'haiku'];
let DEFAULT_FAMILY = (process.env.CLAUDE_DASHBOARD_MODEL || 'haiku').toLowerCase();
if (!FAMILIES.includes(DEFAULT_FAMILY)) DEFAULT_FAMILY = 'haiku';

// Calibration ratios: scale the dashboard's list-price cost to approximate the
// real billed amount on Anthropic plans. Premium and Standard tiers have very
// different effective discounts (~0.71 vs ~0.24 as of 2026-05), so a single
// org-wide ratio is wrong for mixed teams.
//
// Lookup order per user:
//   1. Per-tier ratio from .ai-memory/calibration-tiers.json
//      (premium_users array decides tier; everyone else is standard)
//   2. BILLING_CALIBRATION env var as a single-ratio fallback
//   3. 1.0 (no calibration) when neither is set
//
// Re-derive monthly: Console MTD ÷ dashboard list-price MTD for one user per tier.
const TIERS_FILE = path.join(ROOT_DIR, '.ai-memory', 'calibration-tiers.json');
const TIERS_CONFIG = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8'));
    return {
      premium_ratio: Number(raw.premium_ratio) || null,
      standard_ratio: Number(raw.standard_ratio) || null,
      premium_users: new Set(raw.premium_users || []),
    };
  } catch { return null; }
})();
const BILLING_CALIBRATION = (() => {
  const v = parseFloat(process.env.BILLING_CALIBRATION || '');
  return Number.isFinite(v) && v > 0 ? v : 1.0;
})();
function calibrationFor(user) {
  if (TIERS_CONFIG) {
    if (TIERS_CONFIG.premium_users.has(user) && TIERS_CONFIG.premium_ratio) {
      return TIERS_CONFIG.premium_ratio;
    }
    if (TIERS_CONFIG.standard_ratio) return TIERS_CONFIG.standard_ratio;
  }
  return BILLING_CALIBRATION;
}

function modelFamily(ev) {
  const m = String(ev.model || '').toLowerCase();
  // Fable 5 / Mythos 5 — check before the generic tiers so they don't fall
  // through to DEFAULT_FAMILY and get mislabeled as haiku.
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) {
    if (m.includes('opus-4-0') || m.includes('opus-4-1') || m.endsWith('opus-4') || m.includes('opus-3')) {
      return 'opus_legacy';
    }
    return 'opus';
  }
  return DEFAULT_FAMILY;
}

// Adapts an event row's flat token fields to the shape cost.js expects.
function tokensOf(ev) {
  return {
    input: Number(ev.input_tokens || 0),
    output: Number(ev.output_tokens || 0),
    cacheRead: Number(ev.cache_read_tokens || 0),
    cacheCreation: Number(ev.cache_creation_tokens || 0),
    cacheCreation5m: Number(ev.cache_creation_5m_tokens || 0),
    cacheCreation1h: Number(ev.cache_creation_1h_tokens || 0),
  };
}

function estimateCost(ev) {
  // Delegate to the canonical price table (cost.js). Empty/unknown model →
  // cost.js's default tier (Sonnet), matching the write-time hook.
  return computeCostUsd(ev.model || '', tokensOf(ev));
}

// ── Leg-aware constants (preserved verbatim from bash heredoc) ────────────────
const LEG_RESET_THRESHOLD = 0.05;
// A single session_end row should never represent more than this much spend.
// One assistant turn on a 1M-context Opus session tops out around $15; anything
// larger is almost always a cumulative-cost jump from a `claude --print --resume`
// invocation (recap backfill, reconcile tooling) where the hook fired but the
// in-process leg-reset detector saw a continuous monotonic increase. Capping
// protects per-day attribution from these artifacts without disturbing real
// long-running sessions.
const MAX_ROW_DELTA_USD = 50.0;
const LEG_RESET_FIELDS = [
  'cost_usd', 'duration_ms',
  'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens',
  'lines_added', 'lines_removed',
];
const PROMPT_FIELDS = ['prompts'];

// DELTA_FIELDS excludes 'prompts': prompts is monotonic and never resets on
// compaction, so zeroing it on a leg boundary would double-count.
const DELTA_FIELDS = [
  'cost_usd', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens',
  'lines_added', 'lines_removed',
];

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];

function readEvents(root) {
  // Unions the legacy archive + every monthly shard (see _lib/session-events.js).
  // Fold git-name variants onto a canonical user here, the single read chokepoint,
  // so every downstream view (by-user, calibration, sessions list) stays consistent.
  const aliases = loadUserAliases(root);
  const events = readAllEvents(root, 'session_end');
  for (const e of events) {
    if (e && e.user) e.user = canonicalUser(e.user, aliases);
  }
  return events;
}

// Join key for cross-log analytics: rule-injection events live in
// .claude/logs/value-events.jsonl keyed by `sessionId`, while cost/token data
// lives in session-end-events.jsonl keyed by `session_id`. We sum rule counts
// per session here so the sessions table can show "rules injected" next to
// cost — answering "how much context guidance did this session draw, and what
// did it cost?". Rows with an empty sessionId (logged before the session-id
// fix) can't be joined and are skipped.
function readRuleInjections(root) {
  const bySession = new Map(); // sessionId -> { events, rules }
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.claude', 'logs', 'value-events.jsonl'), 'utf8');
  } catch {
    return bySession;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'rule_injection') continue;
    const sid = typeof ev.sessionId === 'string' ? ev.sessionId : '';
    if (!sid) continue;
    const cur = bySession.get(sid) || { events: 0, rules: 0 };
    cur.events += 1;
    cur.rules += Number(ev.count) || 0;
    bySession.set(sid, cur);
  }
  return bySession;
}

function backfillEstimatedCost(events) {
  // `sessionsWithRealCost` is captured from the ORIGINAL stored cost so the
  // `cost_estimated` flag keeps its meaning ("cost was derived post-hoc, not
  // written by the session-stop hook") even after repricing below.
  const sessionsWithRealCost = new Set();
  for (const e of events) {
    if ((e.cost_usd || 0) > 0) sessionsWithRealCost.add(e.session_id || '');
  }
  let estimatedCount = 0;
  for (const e of events) {
    let hasTokens = false;
    for (const k of TOKEN_KEYS) {
      if ((e[k] || 0) > 0) { hasTokens = true; break; }
    }
    if (!hasTokens) continue;

    const hadRealCost = sessionsWithRealCost.has(e.session_id || '');

    // Reprice from token counts via cost.js whenever the model is KNOWN. This
    // self-heals rows a buggy write-time table mispriced (e.g. Opus 4.8 billed
    // as Sonnet) without mutating the git-tracked, union-merged event log — and
    // keeps the dashboard from diverging from the statusline. Rows with an
    // unknown (empty) model keep their stored cost: we can't price what we can't
    // identify, and the test fixtures deliberately carry synthetic costs on
    // empty-model rows to exercise the leg/delta math independent of pricing.
    if (e.model) {
      e.cost_usd = estimateCost(e);
    } else if (!hadRealCost && (e.cost_usd || 0) === 0) {
      // Legacy backfill path: derive a cost for zero-cost, unknown-model rows.
      e.cost_usd = estimateCost(e);
    }

    if (!hadRealCost) {
      e.cost_estimated = true;
      estimatedCount += 1;
    }
  }
  return { sessionsWithRealCost, estimatedCount };
}

function applyReconciledAttribution(events) {
  const sessionsReconciled = new Set();
  let reconciledEventCount = 0;
  for (const e of events) {
    if (!e.attribution_review_needed) continue;
    // Use field PRESENCE (not truthiness) — primary_jira_ticket="" is a deliberate
    // "claim no ticket" signal from the task-jira-mismatch detector.
    if (Object.prototype.hasOwnProperty.call(e, 'primary_jira_ticket')) {
      e.jira_ticket = e.primary_jira_ticket;
    }
    if (e.primary_project) {
      e.project = e.primary_project;
    }
    const sid = e.session_id || '';
    if (sid) sessionsReconciled.add(sid);
    reconciledEventCount += 1;
  }
  return { sessionsReconciled, reconciledEventCount };
}

function groupBySession(events) {
  const groups = new Map();
  for (const e of events) {
    const sid = e.session_id || '';
    if (!sid) continue;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(e);
  }
  for (const evs of groups.values()) {
    // ISO 8601 strings sort lexicographically — keep '<' to match Python sort.
    evs.sort((a, b) => {
      const ta = a.ts || '';
      const tb = b.ts || '';
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });
  }
  return groups;
}

function emptyBucket() {
  return {
    input_tokens: 0, output_tokens: 0,
    cache_read: 0, cache_create: 0,
    cost_usd: 0, sessions: 0,
    prompts: 0, lines_added: 0, lines_removed: 0,
  };
}

function getOrInit(map, key) {
  let v = map.get(key);
  if (!v) { v = emptyBucket(); map.set(key, v); }
  return v;
}

function aggregate(events, sessionsWithRealCost, sessionsReconciled, ruleInjBySession = new Map()) {
  const groups = groupBySession(events);
  const byDay = new Map();
  const byUser = new Map();
  const byProject = new Map();
  const total = emptyBucket();
  const aggregated = [];

  for (const [sid, evs] of groups) {
    // Skip automated rule-validator sessions with no real prompts — these are
    // system self-improvement runs, not user sessions.
    const repTask = (evs[evs.length - 1].task || '').trimStart();
    const repPrompts = Math.max(...evs.map(e => e.prompts || 0));
    if (repPrompts === 0 && repTask.startsWith('You are a rule validator for a developer')) continue;

    // ── Pass 2: per-leg max sums (session lifetime aggregate) ───────────────
    const legMax = Object.fromEntries(LEG_RESET_FIELDS.map(f => [f, 0]));
    const totalsLeg = Object.fromEntries(LEG_RESET_FIELDS.map(f => [f, 0]));
    for (const ev of evs) {
      const curCost = ev.cost_usd || 0;
      if (legMax.cost_usd > 0 && curCost < legMax.cost_usd * LEG_RESET_THRESHOLD) {
        for (const f of LEG_RESET_FIELDS) {
          totalsLeg[f] += legMax[f];
          legMax[f] = 0;
        }
      }
      for (const f of LEG_RESET_FIELDS) {
        const v = ev[f] || 0;
        if (v > legMax[f]) legMax[f] = v;
      }
    }
    for (const f of LEG_RESET_FIELDS) totalsLeg[f] += legMax[f];

    const first = evs[0];
    const last = evs[evs.length - 1];
    const merged = { ...last };
    merged.ts = first.ts || last.ts || '';
    for (const f of LEG_RESET_FIELDS) merged[f] = totalsLeg[f];
    for (const f of PROMPT_FIELDS) {
      let mx = 0;
      for (const ev of evs) {
        const v = ev[f] || 0;
        if (v > mx) mx = v;
      }
      merged[f] = mx;
    }
    merged.cost_estimated = !sessionsWithRealCost.has(sid);
    aggregated.push(merged);

    // ── Pass 3: delta attribution ──────────────────────────────────────────
    // For daily attribution, prompts is treated as a monotonic delta too —
    // since prompts never resets on leg-reset (per AC-12), per-event delta
    // sums back to max() across the session, preserving user/project totals
    // while spreading multi-day sessions across each day's actual activity.
    let maxVals = Object.fromEntries(DELTA_FIELDS.map(f => [f, 0]));
    let maxPrompts = 0;
    const seenDays = new Set();
    // Per-(session, day) deltas — surfaced on each session as `active_days` so
    // the client can credit each day a session was actually active, not just
    // the day it started. Without this, a session spanning two days collapses
    // onto its first day in the client's daily table.
    const perDay = new Map();
    const ensureDayBucket = (d) => {
      let b = perDay.get(d);
      if (!b) {
        b = {
          date: d, prompts: 0,
          cost_usd: 0,
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_creation_tokens: 0,
          lines_added: 0, lines_removed: 0,
        };
        perDay.set(d, b);
      }
      return b;
    };
    const repIsInteractive = repPrompts >= 2;
    for (const ev of evs) {
      const curVals = Object.fromEntries(DELTA_FIELDS.map(f => [f, Number(ev[f] || 0)]));
      if (maxVals.cost_usd > 0 && curVals.cost_usd < maxVals.cost_usd * LEG_RESET_THRESHOLD) {
        maxVals = Object.fromEntries(DELTA_FIELDS.map(f => [f, 0]));
      }
      const deltas = {};
      for (const f of DELTA_FIELDS) {
        deltas[f] = Math.max(0, curVals[f] - maxVals[f]);
        if (curVals[f] > maxVals[f]) maxVals[f] = curVals[f];
      }
      if (deltas.cost_usd > MAX_ROW_DELTA_USD) deltas.cost_usd = MAX_ROW_DELTA_USD;
      const curPrompts = Number(ev.prompts || 0);
      const promptDelta = Math.max(0, curPrompts - maxPrompts);
      if (curPrompts > maxPrompts) maxPrompts = curPrompts;
      const evDate = String(ev.ts || '').slice(0, 10);
      const evUser = ev.user || 'unknown';
      const evProject = ev.project || 'unknown';
      const dayB = getOrInit(byDay, evDate);
      const userB = getOrInit(byUser, evUser);
      const projB = getOrInit(byProject, evProject);
      // Count this session once per distinct active day.
      if (evDate && !seenDays.has(evDate)) {
        seenDays.add(evDate);
        dayB.sessions += 1;
        if (repIsInteractive) dayB.interactive_sessions = (dayB.interactive_sessions || 0) + 1;
        else dayB.auxiliary_sessions = (dayB.auxiliary_sessions || 0) + 1;
      }
      if (evDate) {
        const sdayB = ensureDayBucket(evDate);
        sdayB.prompts += promptDelta;
        sdayB.cost_usd += deltas.cost_usd;
        sdayB.input_tokens += deltas.input_tokens;
        sdayB.output_tokens += deltas.output_tokens;
        sdayB.cache_read_tokens += deltas.cache_read_tokens;
        sdayB.cache_creation_tokens += deltas.cache_creation_tokens;
        sdayB.lines_added += deltas.lines_added;
        sdayB.lines_removed += deltas.lines_removed;
      }
      dayB.input_tokens += deltas.input_tokens;
      dayB.output_tokens += deltas.output_tokens;
      dayB.cache_read += deltas.cache_read_tokens;
      dayB.cache_create += deltas.cache_creation_tokens;
      dayB.cost_usd += deltas.cost_usd;
      dayB.lines_added += deltas.lines_added;
      dayB.lines_removed += deltas.lines_removed;
      dayB.prompts += promptDelta;
      userB.input_tokens += deltas.input_tokens;
      userB.output_tokens += deltas.output_tokens;
      userB.cache_read += deltas.cache_read_tokens;
      userB.cache_create += deltas.cache_creation_tokens;
      userB.cost_usd += deltas.cost_usd;
      userB.lines_added += deltas.lines_added;
      userB.lines_removed += deltas.lines_removed;
      projB.input_tokens += deltas.input_tokens;
      projB.output_tokens += deltas.output_tokens;
      projB.cache_read += deltas.cache_read_tokens;
      projB.cache_create += deltas.cache_creation_tokens;
      projB.cost_usd += deltas.cost_usd;
      projB.lines_added += deltas.lines_added;
      projB.lines_removed += deltas.lines_removed;
      total.input_tokens += deltas.input_tokens;
      total.output_tokens += deltas.output_tokens;
      total.cache_read += deltas.cache_read_tokens;
      total.cache_create += deltas.cache_creation_tokens;
      total.cost_usd += deltas.cost_usd;
      total.lines_added += deltas.lines_added;
      total.lines_removed += deltas.lines_removed;
    }
    // Stash per-day deltas on the merged session so the client can credit each
    // active day. Sorted ascending by date for stable serialization.
    merged.active_days = [...perDay.values()]
      .filter(b => b.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(b => ({
        date: b.date,
        prompts: b.prompts,
        cost_usd: round2(b.cost_usd),
        input_tokens: b.input_tokens,
        output_tokens: b.output_tokens,
        cache_read_tokens: b.cache_read_tokens,
        cache_creation_tokens: b.cache_creation_tokens,
        lines_added: b.lines_added,
        lines_removed: b.lines_removed,
      }));
  }

  // total.sessions is unique session count; daily[*].sessions counts each session
  // once per active day. These intentionally diverge for multi-day sessions —
  // sum(daily.sessions) >= total.sessions.
  total.sessions = aggregated.length;

  const sessionsList = [];
  const byModel = new Map();
  for (const e of aggregated) {
    const ts = String(e.ts || '').slice(0, 10);
    const user = e.user || 'unknown';
    const project = e.project || 'unknown';
    const inTok = e.input_tokens || 0;
    const outTok = e.output_tokens || 0;
    const cr = e.cache_read_tokens || 0;
    const cc = e.cache_creation_tokens || 0;
    const cost = e.cost_usd || 0;
    const prompts = e.prompts || 0;
    const dur = e.duration_ms || 0;
    const la = e.lines_added || 0;
    const lr = e.lines_removed || 0;

    // Daily sessions/prompts are credited per active day inside Pass 3 above.
    // User and project counts remain whole-session: a session is one session
    // for the user/project who owns it, regardless of how many days it spans.
    const userB = getOrInit(byUser, user);
    const projB = getOrInit(byProject, project);
    userB.sessions += 1;
    userB.prompts += prompts;
    projB.sessions += 1;
    projB.prompts += prompts;
    total.prompts += prompts;

    const sid = e.session_id || '';
    const ratio = calibrationFor(user);
    // Honest 'unknown' when the session carries no model (older events / missing
    // statusline) rather than silently bucketing it as the default family.
    const family = e.model ? modelFamily(e) : 'unknown';

    // Roll cost/tokens up by model family so tiered-routing savings (Opus vs
    // Sonnet vs Haiku spend) are measurable at a glance.
    let mb = byModel.get(family);
    if (!mb) { mb = { model: family, sessions: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }; byModel.set(family, mb); }
    mb.sessions += 1;
    mb.input_tokens += inTok;
    mb.output_tokens += outTok;
    mb.cost_usd += cost;

    const ruleInj = ruleInjBySession.get(sid) || { events: 0, rules: 0 };
    sessionsList.push({
      session_id: sid.slice(0, 8),
      rule_injections: ruleInj.rules,
      rule_injection_events: ruleInj.events,
      ts,
      user,
      project,
      model: family,
      task: e.task || '',
      jira_ticket: e.jira_ticket || '',
      primary_jira_ticket: e.primary_jira_ticket || '',
      input_tokens: inTok,
      output_tokens: outTok,
      cache_read_tokens: cr,
      cache_creation_tokens: cc,
      cost_usd: round2(cost),
      cost_estimated: Boolean(e.cost_estimated),
      cost_estimated_usd: e.cost_estimated ? round2(cost) : 0.0,
      attribution_reconciled: sessionsReconciled.has(sid),
      // Per-session calibrated cost — ships down so the client-side aggregator
      // (which re-runs whenever the date filter changes) can sum it without
      // needing the tier config or rerunning calibrationFor() in the browser.
      calibration_ratio: ratio,
      cost_billed_usd: round2(cost * ratio),
      prompts,
      duration_min: dur ? round1(dur / 60000) : 0,
      lines_added: la,
      lines_removed: lr,
      // Per-day deltas so the client credits each active day, not just the
      // first one. Falls back to [{date: ts, …whole-session totals}] for legacy
      // single-day sessions so the client can iterate unconditionally.
      active_days: (Array.isArray(e.active_days) && e.active_days.length > 0)
        ? e.active_days
        : [{
            date: ts,
            prompts,
            cost_usd: round2(cost),
            input_tokens: inTok,
            output_tokens: outTok,
            cache_read_tokens: cr,
            cache_creation_tokens: cc,
            lines_added: la,
            lines_removed: lr,
          }],
    });
  }

  // ── Sort & round ────────────────────────────────────────────────────────
  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([k, v]) => ({ date: k, ...v, cost_usd: round2(v.cost_usd) }));
  const users = [...byUser.entries()]
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([k, v]) => {
      const ratio = calibrationFor(k);
      return {
        user: k,
        ...v,
        cost_usd: round2(v.cost_usd),
        calibration_ratio: ratio,
        cost_billed_usd: round2(v.cost_usd * ratio),
      };
    });
  const projects = [...byProject.entries()]
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([k, v]) => ({ project: k, ...v, cost_usd: round2(v.cost_usd) }));
  sessionsList.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  total.cost_usd = round2(total.cost_usd);
  // Sum of per-user calibrated costs — the only honest org-wide "billed (est.)"
  // when tiers differ. Computed from `users` (already calibrated) so the total
  // matches what the per-user table sums to.
  total.cost_billed_usd = round2(users.reduce((acc, u) => acc + (u.cost_billed_usd || 0), 0));

  const byModelList = [...byModel.values()]
    .map(m => ({ ...m, cost_usd: round2(m.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  return { total, daily, users, projects, sessionsList, byModelList };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

function isoNowZ() {
  // Python's datetime.utcnow().isoformat()+'Z' -> the same shape toISOString() yields
  // (millisecond precision). Downstream consumers display it verbatim.
  return new Date().toISOString();
}

// ── AI Adoption — Phase 1 ─────────────────────────────────────────────────────
// Targets are env-overridable so we can re-baseline without code changes.
// 30 prompts/day comes from Anthropic Pro tier 5-hour window cap (~40 prompts
// per window) and AngelHack/Portkey power-user inflection (>20/day = paid tier).
// 4 active days/week is the team-set baseline for sustained AI adoption.
const ADOPTION_MIN_PROMPTS_PER_DAY = Number(process.env.ADOPTION_MIN_PROMPTS_PER_DAY || 30);
const ADOPTION_MIN_ACTIVE_DAYS_PER_WEEK = Number(process.env.ADOPTION_MIN_ACTIVE_DAYS_PER_WEEK || 4);
// Below this monthly-normalized token volume, a per-person SP/1M ratio is too
// noisy to trust: a handful of tokens under a whole-ticket SP credit makes the
// ratio explode, so light/inactive users float to the top. We blank the ratio
// out below the floor and only rank developers who clear it. Expressed per
// MONTH so the floor holds for any window length (7d/30d/custom).
const ADOPTION_MIN_TOKENS_PER_MONTH = Number(process.env.ADOPTION_MIN_TOKENS_PER_MONTH || 4e6);
// Empirical-Bayes prior strength, in millions of tokens. Each developer's raw
// SP/1M is shrunk toward the team-wide rate as if they carried this many
// million tokens of "average" history — tiny samples regress to the team mean
// instead of spiking. ~4 ≈ one month at the volume floor.
const ADOPTION_SHRINK_PRIOR_M = Number(process.env.ADOPTION_SHRINK_PRIOR_M || 4);

// Minimum comparable-ticket count before the AI-sizing accuracy tile shows
// computed numbers instead of "insufficient data" (R-2). Env-overridable like
// the adoption thresholds above.
const AI_ACCURACY_MIN_SAMPLE = Number(process.env.AI_ACCURACY_MIN_SAMPLE || 2);

// Read SP data from the cache file populated by:
//   - scripts/hooks/session-stop.js (incremental, 1 ticket/session)
//   - scripts/refresh-jira-story-points.js (manual / cron backfill)
//
// The dashboard intentionally NEVER calls Jira itself, so teammates without
// Jira credentials still render the AI Adoption section against the
// git-committed cache file.
function readSpFromCache() {
  const cache = loadSpCache(ROOT_DIR);
  const cacheFile = spCachePath(ROOT_DIR);
  if (!fs.existsSync(cacheFile)) {
    return { byTicket: {}, available: false, reason: 'cache-missing' };
  }
  return { byTicket: cache.entries || {}, available: true, reason: 'ok' };
}

// Read AI estimates from .ai-memory/ai-estimates.json, populated by
// scripts/set-ai-estimate.js. Mirrors readSpFromCache — the dashboard never
// calls Jira; the AI cache is Jira-free by design. `available` is false when
// the file is absent or has no entries.
function readAiFromCache() {
  const cache = loadAiEstimatesCache(ROOT_DIR);
  const byTicket = cache.entries || {};
  const available = fs.existsSync(aiEstimatesPath(ROOT_DIR)) && Object.keys(byTicket).length > 0;
  return { byTicket, available };
}

// The delivered "universe" (every ticket resolved in the cached window),
// used to compute AI coverage and the untracked-ticket list. Read-only mirror
// of readSpFromCache — the dashboard never blocks on Jira; the refresh is
// opportunistic (see main). `available` is false when the cache is absent.
function readDeliveredFromCache() {
  const cache = loadPeriodCache(ROOT_DIR);
  const byTicket = cache.entries || {};
  const available = fs.existsSync(periodCachePath(ROOT_DIR)) && Object.keys(byTicket).length > 0;
  return { byTicket, available, window: cache.window, generated_at: cache.generated_at };
}

function readTeamConfig() {
  return loadTeamConfig(ROOT_DIR);
}

function buildData(events) {
  const { sessionsWithRealCost, estimatedCount } = backfillEstimatedCost(events);
  const { sessionsReconciled, reconciledEventCount } = applyReconciledAttribution(events);
  const ruleInjBySession = readRuleInjections(ROOT_DIR);
  const { total, daily, users, projects, sessionsList, byModelList } = aggregate(events, sessionsWithRealCost, sessionsReconciled, ruleInjBySession);
  const data = {
    generated_at: isoNowZ(),
    billing_calibration: BILLING_CALIBRATION,
    total,
    daily,
    by_user: users,
    by_project: projects,
    by_model: byModelList,
    sessions: sessionsList,
  };
  return { data, estimatedCount, reconciledEventCount, sessionsReconciled, users };
}

// AI-landed-code metric — READ from a weekly delivery snapshot written by whatever
// job computes it in your workspace (.ai-memory/delivery-history.jsonl), not recomputed
// here: that job already joins protected-branch diffs against the AI-touched ticket set,
// and duplicating the fetch would drift. Expected row shape (one per week):
//   { tier: 'weekly', window: {start,end}, landed_lines, ai_landed_lines, ai_landed_pct, ai_cost }
// Absent file → the section degrades to "not available" instead of failing.
// Team-level ONLY (governance: no per-dev efficiency ratio). Surfaces the cost →
// shipped-output link the token dashboard exists to show ($ per 1k AI-landed lines).
function readAiLandedFromDeliverySnapshot(root) {
  try {
    const p = path.join(root, '.ai-memory', 'delivery-history.jsonl');
    const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o && o.tier === 'weekly' && o.landed_lines != null);
    if (!rows.length) return { available: false, reason: 'no weekly delivery snapshot with landed lines yet' };
    const series = rows.slice(-8).map((w) => ({
      window: w.window,
      landed_lines: w.landed_lines,
      ai_landed_lines: w.ai_landed_lines,
      ai_landed_pct: w.ai_landed_pct,
      ai_cost: w.ai_cost,
      // team ROI: API-equivalent AI spend that week per 1k AI-attributed lines shipped to master/release
      cost_per_kloc: w.ai_landed_lines ? +(1000 * (w.ai_cost || 0) / w.ai_landed_lines).toFixed(2) : null,
    }));
    return { available: true, series, latest: series[series.length - 1] };
  } catch (e) { return { available: false, reason: String(e.message) }; }
}

function jsStringLiteral(s) {
  // Embed a JS string literal inside the HTML <script> block. JSON.stringify is
  // valid JS for any string and handles all escape edge cases.
  return JSON.stringify(s);
}

function renderHtml(data, jiraBaseUrl) {
  const inlineData = JSON.stringify(data, null, 2);
  const jiraUrlJs = jsStringLiteral(jiraBaseUrl);
  // Single-source the Delivery math + team-member identity resolution: embed
  // these _lib modules verbatim so the client uses the SAME code the Node tests
  // exercise (no drift).
  const deliveryMetricsSrc = fs.readFileSync(path.join(SCRIPT_DIR, '_lib', 'delivery-metrics.js'), 'utf8');
  const teamIdentitySrc = fs.readFileSync(path.join(SCRIPT_DIR, '_lib', 'team-identity.js'), 'utf8');
  // The dashboard JS uses `collapseStorageKey` (lowercase) instead of an
  // ALL_CAPS_KEY identifier so this source file does not itself match the
  // shell-secret heuristic in scripts/_lib/heuristics.js. Behavior is identical.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Consumption Dashboard</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --orange: #f97316; --green: #10b981; --amber: #f59e0b; --red: #ef4444; --blue: #58a6ff; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
  h1 { font-size: 1.5rem; color: var(--orange); margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 8px; }
  .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  .filter-btn { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; color: var(--muted); cursor: pointer; font-size: 0.8rem; transition: all 0.15s; }
  .filter-btn:hover { border-color: var(--orange); color: var(--text); }
  .filter-btn.active { background: var(--orange); color: #000; border-color: var(--orange); font-weight: 600; }
  .filter-sep { color: var(--border); margin: 0 4px; }
  .month-select { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 0.8rem; cursor: pointer; }
  .month-select:focus { outline: 1px solid var(--orange); }
  .date-input { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; color: var(--text); font-size: 0.8rem; cursor: pointer; color-scheme: dark; }
  .date-input:focus { outline: 1px solid var(--orange); }
  .date-input.active { border-color: var(--orange); }
  .filter-label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .card-value { font-size: 1.5rem; font-weight: 700; }
  .card-detail { font-size: 0.8rem; color: var(--muted); margin-top: 4px; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 1.1rem; color: var(--text); margin-bottom: 12px; border-bottom: 1px solid var(--border); padding-bottom: 8px; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; }
  .section h2:hover { color: var(--orange); }
  .section h2::before { content: '▾'; display: inline-block; font-size: 0.9rem; color: var(--muted); transition: transform 0.15s; }
  .section.collapsed h2::before { transform: rotate(-90deg); }
  .section.collapsed > :not(h2) { display: none; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 8px 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: rgba(249,115,22,0.05); }
  .bar-cell { position: relative; }
  .bar { height: 20px; border-radius: 3px; display: inline-block; min-width: 2px; }
  .bar-in { background: var(--blue); }
  .bar-out { background: var(--orange); }
  .bar-cache { background: var(--green); opacity: 0.6; }
  .legend { display: flex; gap: 16px; margin-bottom: 12px; font-size: 0.8rem; color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend .dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .info { display: inline-block; margin-left: 3px; font-size: 0.75em; color: var(--muted); border: 1px solid currentColor; border-radius: 50%; width: 12px; height: 12px; line-height: 11px; text-align: center; cursor: help; font-style: normal; font-weight: 400; }
  .help-banner { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; font-size: 0.8rem; color: var(--muted); margin-bottom: 16px; line-height: 1.5; }
  .help-banner strong { color: var(--text); }
  td a, th a { color: var(--blue); text-decoration: none; border-bottom: 1px dotted currentColor; }
  td a:hover, th a:hover { color: var(--orange); border-bottom-style: solid; }
  .cost-hi { color: var(--red); }
  .cost-mid { color: var(--amber); }
  .cost-lo { color: var(--green); }
  .lines-add { color: var(--green); }
  .lines-rem { color: var(--red); }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }
  .reconciled-badge { display: inline-block; margin-left: 4px; font-size: 0.7em; color: var(--amber, #d97706); border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; cursor: help; font-weight: 600; vertical-align: 2px; }
  .empty-msg { color: var(--muted); padding: 24px; text-align: center; font-style: italic; }
  #daily-user-table th, #daily-user-table td { min-width: 70px; }
  #daily-user-table tr.total-row td { border-top: 2px solid var(--border); font-weight: 600; }
  thead th { cursor: pointer; user-select: none; }
  thead th:hover { color: var(--text); }
  thead th::after { content: '↕'; opacity: 0.3; margin-left: 4px; font-size: 0.8em; font-weight: 400; }
  thead th.sort-asc::after { content: '↑'; opacity: 0.95; color: var(--orange); }
  thead th.sort-desc::after { content: '↓'; opacity: 0.95; color: var(--orange); }
</style>
</head>
<body>
<h1>Token Consumption Dashboard</h1>
<div class="subtitle" id="generated-at"></div>

<div class="filters">
  <span class="filter-label">Period:</span>
  <button class="filter-btn" data-range="all">All Time</button>
  <button class="filter-btn" data-range="ytd">YTD</button>
  <button class="filter-btn" data-range="mtd">MTD</button>
  <button class="filter-btn active" data-range="7d">Last 7d</button>
  <button class="filter-btn" data-range="30d">Last 30d</button>
  <span class="filter-sep">|</span>
  <span class="filter-label">Month:</span>
  <select class="month-select" id="month-picker">
    <option value="">-- select --</option>
  </select>
  <span class="filter-sep">|</span>
  <span class="filter-label">Range:</span>
  <input type="date" class="date-input" id="from-date" aria-label="From date">
  <span class="filter-label">→</span>
  <input type="date" class="date-input" id="to-date" aria-label="To date">
  <button class="filter-btn" id="range-clear" title="Clear custom range">✕</button>
  <span class="filter-sep">|</span>
  <span class="filter-label">Team member:</span>
  <select class="month-select" id="user-filter" title="Filters every section — tokens, delivery, and untracked tickets — for one person. Roster-based: bridges session usernames and Jira assignee names via team-report.md.">
    <option value="">All (team)</option>
  </select>
  <span class="filter-sep">|</span>
  <span class="filter-label">Export CSV:</span>
  <button class="filter-btn" id="export-daily">Daily</button>
  <button class="filter-btn" id="export-users">Users</button>
  <button class="filter-btn" id="export-projects">Projects</button>
  <button class="filter-btn" id="export-sessions">Sessions</button>
  <button class="filter-btn" id="export-all">All (zip-like bundle)</button>
</div>

<div class="section" id="section-summary">
  <h2>Summary</h2>
  <div class="grid" id="summary-cards"></div>
  <div class="help-banner">
    <strong>Sess</strong> = Interactive sessions (≥2 prompts) — real sit-at-keyboard work.
    <strong>Aux</strong> = Auxiliary runs (&lt;2 prompts) — subagents (Task tool), <code>/loop</code> ticks, headless runs. Their cost still counts toward totals.
    <strong>Est %</strong> = Fraction of cost from sessions where statusline never wrote cost back, so the figure was estimated. Lower = more trustworthy.
  </div>
</div>

<div class="section" id="section-delivery">
  <h2>Delivery &amp; Velocity</h2>
  <div class="subtitle" id="delivery-window" style="margin-bottom:10px;"></div>
  <div class="grid" id="delivery-cards"></div>
  <table id="delivery-fte-table" style="margin-top:16px;"><thead><tr>
    <th>Segment / Developer</th>
    <th title="Story points delivered (Done) in the window, credited by Jira assignee's role">SP delivered<span class="info">i</span></th>
    <th title="Full-time-equivalent headcount = sum of roster allocation for the segment (business-days-off not modelled — allocation-only approximation)">FTE<span class="info">i</span></th>
    <th title="(SP ÷ months-in-window) ÷ FTE. Normalized to a monthly rate so any window length is comparable.">SP/FTE/mo<span class="info">i</span></th>
    <th title="SP ÷ person-days, where person-days = business days in window × FTE. The per-working-day throughput.">SP/FTE/day<span class="info">i</span></th>
    <th title="Pre-AI SP/FTE/month baseline from team-report.md (BE 8.7, FE 14.9; Apr–Jul 2025 calibration)">Pre-AI baseline<span class="info">i</span></th>
    <th title="AI-era SP/FTE/mo ÷ pre-AI baseline. &gt;1× = productivity lift over the pre-AI team.">Multiplier<span class="info">i</span></th>
  </tr></thead><tbody></tbody></table>
  <div class="muted" style="font-size:0.75rem; margin-top:6px; line-height:1.5;">
    Delivered SP = every ticket resolved (Done) in the window from Jira
    (<code>.ai-memory/jira-period-tickets.json</code>, <code>npm run jira:refresh-period</code>) — including tickets AI never touched.
    <strong>SP/FTE/mo</strong> normalizes to a monthly rate so any window length is comparable; the pre-AI <strong>multiplier</strong> (&gt;1× = lift over the pre-AI team) compares AI-era velocity against the team-report.md baselines (BE 8.7, FE 14.9 SP/FTE/mo).
    Use the <strong>Team member</strong> filter at the top of the page for per-person velocity — it scopes every section at once. The table's Team/BE/FE rows and per-developer rows count only SP assigned to the roster (÷ roster FTE); the throughput cards count every delivered ticket for the selected scope.
    FTE uses roster allocation only (days-off calendar not wired) and short windows normalize noisily — treat SP/FTE as an upper-bound approximation.
  </div>
</div>

<div class="section" id="section-adoption">
  <h2>AI Adoption — Phase 1</h2>
  <div id="adoption-banner" class="help-banner" style="display:none;"></div>
  <table id="adoption-table"><thead><tr>
    <th>Developer</th>
    <th title="Total prompts ÷ distinct active days in the selected period">Prompts / active day<span class="info">i</span></th>
    <th title="Distinct active days ÷ weeks in the selected period">Active days / week<span class="info">i</span></th>
    <th title="Sum of input + output tokens for the developer in this period">Tokens</th>
    <th title="Story points per 1M tokens, EMPIRICAL-BAYES SHRUNK toward the team-wide rate so small samples don't spike. Blank ('low vol') below the monthly token floor. SP credited to the Jira assignee; if assignee not in data, the ticket credits the user with the most prompts on it. Hover a cell for the raw ratio + sample size (n tickets).">SP / 1M tokens<span class="info">i</span></th>
    <th title="Same as SP / 1M tokens (shrunk, floor-gated), but counts ONLY story points from tickets in a Done/Closed/Resolved status (Jira statusCategory = done). Measures delivered work, not just assigned. Shows '—' until the SP cache is refreshed with status data.">Done SP / 1M tokens<span class="info">i</span></th>
    <th title="Done tickets per 1M tokens — SP-independent throughput, shrunk + floor-gated like the SP columns. Counts each delivered (Done/Closed/Resolved) ticket credited to the developer, so it captures unpointed tickets the SP columns miss. Shows '—' until the SP cache carries status data.">Done tickets / 1M tokens<span class="info">i</span></th>
  </tr></thead><tbody></tbody></table>
  <div class="muted" style="font-size:0.75rem; margin-top:6px; line-height:1.5;">
    <strong>Two different questions, kept separate.</strong>
    <em>Adoption</em> (are they using AI?) → the <strong>Prompts/active day</strong> and <strong>Active days/week</strong> columns: goals ≥<span id="adoption-goal-ppd"></span> prompts/active day &nbsp;·&nbsp; ≥<span id="adoption-goal-adw"></span> active days/week.
    <em>Efficiency</em> (how much delivered work per token?) → the <strong>/1M tokens</strong> columns. These are a per-person efficiency ratio, NOT an adoption or activity signal — a light AI user can post a high ratio off a single ticket, so treat them as diagnostic and read them alongside the adoption columns, not as a leaderboard. The trustworthy team-level efficiency figure is <strong>cost/SP and SP/FTE/mo</strong> in the Delivery section above (large, stable denominators).
    <br>To stop low-activity users floating to the top, the /1M columns are (1) blanked as <span style="opacity:.6">low vol</span> below a <strong>≥<span id="adoption-goal-floor"></span>M tokens/month</strong> floor and (2) <strong>empirical-Bayes shrunk</strong> toward the team-wide rate so tiny samples regress to the mean instead of spiking. Override via <code>ADOPTION_MIN_PROMPTS_PER_DAY</code> / <code>ADOPTION_MIN_ACTIVE_DAYS_PER_WEEK</code> / <code>ADOPTION_MIN_TOKENS_PER_MONTH</code> / <code>ADOPTION_SHRINK_PRIOR_M</code>.
  </div>
</div>

<div class="section" id="section-ai-landed">
  <h2>AI Code Landed → Cost</h2>
  <div class="subtitle" id="ai-landed-window" style="margin-bottom:10px;"></div>
  <div class="grid" id="ai-landed-cards"></div>
  <div class="muted" style="font-size:0.75rem; margin-top:6px; line-height:1.5;">
    Team-level, sourced from the latest <strong>weekly delivery snapshot</strong> (not recomputed here).
    Share of hand-written lines merged to protected branches (master/main/release) that landed on
    AI-touched tickets — a <em>ticket-attributed proxy</em> (a PR on an AI ticket may still contain human
    lines; generated/vendored files excluded). AI spend is API-equivalent, not billed. This is a
    <strong>team ROI signal, never a per-developer metric</strong>.
  </div>
</div>

<div class="section" id="section-ai-accuracy">
  <h2>AI Sizing Accuracy</h2>
  <div class="grid" id="ai-accuracy-cards"></div>
  <div class="muted" style="font-size:0.75rem; margin-top:6px; line-height:1.5;">
    Compares the AI's own estimate (<code>.ai-memory/ai-estimates.json</code>) against the human story points (<code>.ai-memory/jira-story-points.json</code>) over tickets carrying both.
    <strong>MAE</strong> = mean absolute error in story points; <strong>Hit Rate</strong> = share within one step on the <code>0.5,1,2,3,5,8,13</code> scale.
    Needs ≥<span id="ai-accuracy-min"></span> comparable tickets before numbers show. Override via <code>AI_ACCURACY_MIN_SAMPLE</code>.
  </div>
</div>

<div class="section" id="section-daily">
  <h2>Daily Usage</h2>
  <div class="legend">
    <span><span class="dot" style="background:var(--blue)"></span> Input tokens</span>
    <span><span class="dot" style="background:var(--orange)"></span> Output tokens</span>
    <span><span class="dot" style="background:var(--green); opacity:0.6"></span> Cache reads</span>
  </div>
  <table id="daily-table"><thead><tr><th>Date</th><th title="Interactive sessions (≥2 prompts) — real sit-at-keyboard work">Sess<span class="info">i</span></th><th title="Auxiliary runs (&lt;2 prompts): subagents, /loop ticks, headless processes">Aux<span class="info">i</span></th><th>Prompts</th><th>Input</th><th>Output</th><th>Cache Read</th><th>+Lines</th><th>-Lines</th><th title="List-price value: tokens priced at Anthropic pay-as-you-go rates. This is value delivered, NOT the invoiced amount (seat subscriptions cover most of it).">List $<span class="info">i</span></th><th>Tokens</th></tr></thead><tbody></tbody></table>
</div>

<div class="section" id="section-users">
  <h2>By User</h2>
  <table id="user-table"><thead><tr><th>User</th><th title="Interactive sessions (≥2 prompts) — real sit-at-keyboard work">Sess<span class="info">i</span></th><th title="Auxiliary runs (&lt;2 prompts): subagents, /loop ticks, headless processes">Aux<span class="info">i</span></th><th>Prompts</th><th>Input</th><th>Output</th><th>+Lines</th><th>-Lines</th><th title="List-price value: tokens priced at Anthropic pay-as-you-go rates. This is value delivered, NOT the invoiced amount (seat subscriptions cover most of it).">List $<span class="info">i</span></th><th title="Rough estimate only: list price × per-tier calibration ratio. Unreliable for seat-covered users (their metered spend can be $0 regardless of usage). For the real invoiced number, see .ai-memory/admin-cost-<month>.json (npm run cost:admin).">Est. billed<span class="info">i</span></th><th title="Fraction of cost from estimated (statusline-missing) sessions. Lower = more trustworthy.">Est %<span class="info">i</span></th><th title="(AI story points × 1,000,000) ÷ tokens. AI SP (from .ai-memory/ai-estimates.json) credited to the Jira assignee; if assignee not in data, the ticket credits the user with the most prompts on it — the same crediting the SP / 1M column uses. Dash = no AI-estimated tickets credited to this user.">AI-SP / 1M tokens<span class="info">i</span></th></tr></thead><tbody></tbody></table>
</div>

<div class="section" id="section-projects">
  <h2>By Project</h2>
  <table id="project-table"><thead><tr><th>Project</th><th title="Interactive sessions (≥2 prompts) — real sit-at-keyboard work">Sess<span class="info">i</span></th><th title="Auxiliary runs (&lt;2 prompts): subagents, /loop ticks, headless processes">Aux<span class="info">i</span></th><th>Prompts</th><th>Input</th><th>Output</th><th>+Lines</th><th>-Lines</th><th title="List-price value: tokens priced at Anthropic pay-as-you-go rates. This is value delivered, NOT the invoiced amount (seat subscriptions cover most of it).">List $<span class="info">i</span></th><th title="Fraction of cost from estimated (statusline-missing) sessions. Lower = more trustworthy.">Est %<span class="info">i</span></th></tr></thead><tbody></tbody></table>
</div>

<div class="section" id="section-tickets">
  <h2>By Jira Ticket</h2>
  <table id="ticket-table"><thead><tr><th>Ticket</th><th title="Story points from Jira (assignee field). Dash = ticket not in cache or no SP set. Run 'npm run jira:refresh' to update.">SP<span class="info">i</span></th><th title="The AI's own independent story-point estimate for this ticket (from .ai-memory/ai-estimates.json, set by scripts/set-ai-estimate.js). Never written to Jira. Dash = no AI estimate recorded.">AI Est<span class="info">i</span></th><th title="Interactive sessions (≥2 prompts) — real sit-at-keyboard work">Sess<span class="info">i</span></th><th title="Auxiliary runs (&lt;2 prompts): subagents, /loop ticks, headless processes">Aux<span class="info">i</span></th><th>Prompts</th><th>Input</th><th>Output</th><th>+Lines</th><th>-Lines</th><th title="List-price value: tokens priced at Anthropic pay-as-you-go rates. This is value delivered, NOT the invoiced amount (seat subscriptions cover most of it).">List $<span class="info">i</span></th><th title="Fraction of cost from estimated (statusline-missing) sessions. Lower = more trustworthy.">Est %<span class="info">i</span></th></tr></thead><tbody></tbody></table>
</div>

<div class="section collapsed" id="section-untracked">
  <h2>Delivered Tickets Not Tracked by AI</h2>
  <div id="untracked-banner" class="help-banner"></div>
  <table id="untracked-table"><thead><tr>
    <th>Ticket</th>
    <th>Summary</th>
    <th>Assignee</th>
    <th>Type</th>
    <th title="Story points from Jira">SP<span class="info">i</span></th>
    <th title="Resolution date (status → Done)">Resolved<span class="info">i</span></th>
  </tr></thead><tbody></tbody></table>
  <div class="muted" style="font-size:0.75rem; margin-top:6px; line-height:1.5;">
    Delivered tickets resolved in the selected window that have <strong>no Claude Code session</strong> attributed to them —
    work that shipped without the workspace AI. Diffs the Jira delivered-universe cache against the AI-tracked ticket set.
    Sourced from Jira directly (<code>npm run jira:refresh-period</code>); independent of the local session events.
  </div>
</div>

<div class="section" id="section-daily-user">
  <h2>Daily Usage by User</h2>
  <table id="daily-user-table"><thead></thead><tbody></tbody></table>
</div>

<div class="section" id="section-sessions">
  <h2>Sessions</h2>
  <table id="session-table"><thead><tr><th>ID</th><th>Date</th><th>User</th><th>Project</th><th>Model</th><th>Ticket</th><th>Task</th><th>Prompts</th><th title="Total rules injected across all prompts in this session (from .claude/logs/value-events.jsonl, joined on session id). Dash = no rule-injection events recorded for this session.">Rules<span class="info">i</span></th><th>Input</th><th>Output</th><th>+Lines</th><th>-Lines</th><th>Duration</th><th title="List-price value: tokens priced at Anthropic pay-as-you-go rates. This is value delivered, NOT the invoiced amount (seat subscriptions cover most of it).">List $<span class="info">i</span></th></tr></thead><tbody></tbody></table>
</div>

<script>
// ── Embedded from scripts/_lib/delivery-metrics.js (single source of truth) ──
${deliveryMetricsSrc}
// ── Embedded from scripts/_lib/team-identity.js (single source of truth) ──
${teamIdentitySrc}

// NOTE: the embedded modules above MUST stay in this SAME <script> block as the
// client code below. The deployed build (scripts/combine-dashboards.js) wraps
// EACH <script> in its own IIFE, so a separate module <script> would hide
// buildTeamIdentity/computeDeliveryMetrics from this scope and render() would
// throw ReferenceError → blank dashboard.
const raw = ${inlineData};
const JIRA_BASE_URL = ${jiraUrlJs};

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jiraLink(ticket) {
  if (!ticket || ticket === '(no ticket)') return '<span class="muted">-</span>';
  const looksLikeKey = /^[A-Z]+-\\d+$/.test(ticket);
  if (!looksLikeKey || !JIRA_BASE_URL) {
    const esc = escapeHtml(ticket);
    return '<span title="' + esc + '">' + esc + '</span>';
  }
  const esc = escapeHtml(ticket);
  const url = JIRA_BASE_URL + '/browse/' + encodeURIComponent(ticket);
  return '<a href="' + url + '" target="_blank" rel="noopener" title="Open ' + esc + ' in Jira">' + esc + '</a>';
}

function fmt(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtDuration(min) {
  if (!min || min <= 0) return '-';
  if (min < 1) return '<1m';
  if (min < 60) return Math.round(min) + 'm';
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
}
function costClass(c) { return c >= 5 ? 'cost-hi' : c >= 1 ? 'cost-mid' : 'cost-lo'; }
function estClass(p) { return p > 25 ? 'cost-hi' : p > 5 ? 'cost-mid' : 'cost-lo'; }
function estPct(b) { return b.cost_usd > 0 ? (b.cost_estimated_usd / b.cost_usd) * 100 : 0; }

// Anchor relative windows (7d/30d/MTD/YTD) on when the snapshot was generated,
// NOT the wall clock at open-time — a static report's "Last 7d" must stay fixed
// to its data, else opening an aged file shows an empty default view.
const now = new Date(raw.generated_at);
const today = now.toISOString().slice(0, 10);
const yearStart = now.getFullYear() + '-01-01';
const monthStart = today.slice(0, 8) + '01';

// Free-form calendar range. Populated by the From/To date inputs; consumed by
// dateRange('custom') so it flows through both render() and currentSlice() (CSV
// exports) identically to the presets. Empty ends stay open (min/max sentinel).
let customFrom = '';
let customTo = '';

function dateRange(range, monthVal) {
  if (monthVal) {
    const y = parseInt(monthVal.slice(0, 4)), m = parseInt(monthVal.slice(5, 7));
    const from = monthVal + '-01';
    const last = new Date(y, m, 0).getDate();
    const to = monthVal + '-' + String(last).padStart(2, '0');
    return { from, to };
  }
  if (range === 'custom') {
    return { from: customFrom || '2000-01-01', to: customTo || '2099-12-31' };
  }
  switch (range) {
    case 'ytd': return { from: yearStart, to: today };
    case 'mtd': return { from: monthStart, to: today };
    case '7d':  { const d = new Date(now); d.setDate(d.getDate() - 7); return { from: d.toISOString().slice(0,10), to: today }; }
    case '30d': { const d = new Date(now); d.setDate(d.getDate() - 30); return { from: d.toISOString().slice(0,10), to: today }; }
    default: return { from: '2000-01-01', to: '2099-12-31' };
  }
}

const isInteractiveSession = s => (s.prompts || 0) >= 2;

function normalizeTicket(raw) {
  if (!raw) return '(no ticket)';
  let t = String(raw).trim();
  if (!t) return '(no ticket)';
  const m = t.match(/(?:jira_ticket\\s*:\\s*)?["']?([A-Z]+-\\d+)["']?/);
  return m ? m[1] : t;
}

const TICKET_KEY_RE = /^[A-Z]+-\\d+$/;
function ticketKeyOf(s) {
  const k = (s.primary_jira_ticket || s.jira_ticket || '').trim();
  return TICKET_KEY_RE.test(k) ? k : '';
}

// Ticket → credited user: the Jira assignee when they appear in the data,
// else the user with the most prompts on the ticket. Shared by the SP / 1M
// (adoption) and AI-SP / 1M (By User) columns so both credit identically.
function pickCreditUser(tk, sp, promptsByUser) {
  const meta = sp[tk];
  const assignee = meta && meta.assignee;
  if (assignee && promptsByUser[assignee] != null) return assignee;
  let topUser = '', topPrompts = -1;
  for (const [u, p] of Object.entries(promptsByUser)) {
    if (p > topPrompts) { topUser = u; topPrompts = p; }
  }
  return topUser;
}

// user → (credited AI SP × 1M) ÷ in-window tokens, reusing pickCreditUser so
// the crediting matches the SP / 1M path exactly (one credit per ticket).
function aiSpCreditedByUser(sessions, from, to) {
  const tokensByUser = {};
  const ticketPromptsByUser = {};
  sessions.forEach(s => {
    const days = activeDaysInRange(s, from, to);
    let inWinPrompts = 0, inWinTokens = 0;
    for (const d of days) {
      inWinPrompts += (d.prompts || 0);
      inWinTokens += (d.input_tokens || 0) + (d.output_tokens || 0);
    }
    tokensByUser[s.user] = (tokensByUser[s.user] || 0) + inWinTokens;
    const tk = ticketKeyOf(s);
    if (!tk) return;
    if (!ticketPromptsByUser[tk]) ticketPromptsByUser[tk] = {};
    ticketPromptsByUser[tk][s.user] = (ticketPromptsByUser[tk][s.user] || 0) + inWinPrompts;
  });
  const sp = raw.story_points || {};
  const aiByTicket = (raw.ai_estimates && raw.ai_estimates.byTicket) || {};
  const aiSpByUser = {};
  Object.keys(ticketPromptsByUser).forEach(tk => {
    const ai = aiByTicket[tk];
    if (!ai || !(ai.ai_sp > 0)) return;
    const creditUser = pickCreditUser(tk, sp, ticketPromptsByUser[tk]);
    if (creditUser) aiSpByUser[creditUser] = (aiSpByUser[creditUser] || 0) + Number(ai.ai_sp);
  });
  const perMillion = {};
  Object.keys(tokensByUser).forEach(u => {
    const tok = tokensByUser[u];
    perMillion[u] = tok > 0 ? ((aiSpByUser[u] || 0) * 1e6) / tok : 0;
  });
  return perMillion;
}

function aggregateAdoption(sessions, from, to) {
  const fromDate = new Date(from + 'T00:00:00Z');
  const toDate = new Date(to + 'T00:00:00Z');
  // dateRange() emits "7d" as from = today-7 → to = today, a 7-day span. Don't
  // add 1: the filter button labels (Last 7d/30d) match the math the user expects.
  const windowDays = Math.max(1, Math.round((toDate - fromDate) / 86400000));
  const windowWeeks = windowDays / 7;

  const byUser = {};
  const ticketPromptsByUser = {};
  sessions.forEach(s => {
    if (!byUser[s.user]) {
      byUser[s.user] = { user: s.user, prompts: 0, tokens: 0, activeDays: new Set(), tickets: new Set(), sp: 0, spTickets: 0, doneSp: 0, doneTickets: 0 };
    }
    const u = byUser[s.user];
    // Walk active_days in-window so multi-day sessions credit each calendar day.
    const days = activeDaysInRange(s, from, to);
    let inWinPrompts = 0;
    let inWinTokens = 0;
    for (const d of days) {
      inWinPrompts += (d.prompts || 0);
      inWinTokens += (d.input_tokens || 0) + (d.output_tokens || 0);
      if (d.date) u.activeDays.add(d.date);
    }
    u.prompts += inWinPrompts;
    u.tokens += inWinTokens;
    const tk = ticketKeyOf(s);
    if (tk) {
      u.tickets.add(tk);
      if (!ticketPromptsByUser[tk]) ticketPromptsByUser[tk] = {};
      ticketPromptsByUser[tk][s.user] = (ticketPromptsByUser[tk][s.user] || 0) + inWinPrompts;
    }
  });

  const sp = raw.story_points || {};
  const ticketCreditUser = {};
  Object.keys(ticketPromptsByUser).forEach(tk => {
    ticketCreditUser[tk] = pickCreditUser(tk, sp, ticketPromptsByUser[tk]);
  });

  // First pass: credit SP/tickets per user AND accumulate team totals so we can
  // build the empirical-Bayes prior (the team-wide SP/1M rate) below.
  let teamSp = 0, teamDoneSp = 0, teamDoneTickets = 0, teamTokens = 0;
  Object.values(byUser).forEach(u => {
    for (const tk of u.tickets) {
      if (ticketCreditUser[tk] === u.user && sp[tk] && !sp[tk].error) {
        u.sp += sp[tk].sp || 0;
        u.spTickets += 1;
        // Delivered SP: only tickets whose Jira statusCategory is "done"
        // (Done/Closed/Resolved). The done flag is absent on pre-status cache
        // entries, so those contribute 0 until the cache is refreshed.
        // doneTickets counts the ticket itself (SP-independent), so it captures
        // delivered work even when the ticket is unpointed (sp = 0).
        if (sp[tk].done) { u.doneSp += sp[tk].sp || 0; u.doneTickets += 1; }
      }
    }
    teamSp += u.sp; teamDoneSp += u.doneSp; teamDoneTickets += u.doneTickets; teamTokens += u.tokens;
  });

  // Empirical-Bayes prior = team-wide rate (per 1M tokens). Individual ratios
  // are shrunk toward this, weighted by ADOPTION_SHRINK_PRIOR_M million tokens
  // of "average" history, so a developer with almost no tokens cannot post an
  // outlier ratio off a single ticket — they regress to the team mean instead.
  const cfg = raw.adoption || {};
  const priorM = Number(cfg.shrink_prior_m) || 4;
  const minTokensPerMonth = Number(cfg.min_tokens_per_month) || 4e6;
  const teamTokensM = teamTokens / 1e6;
  const priorSpRate = teamTokensM > 0 ? teamSp / teamTokensM : 0;
  const priorDoneSpRate = teamTokensM > 0 ? teamDoneSp / teamTokensM : 0;
  const priorDoneTixRate = teamTokensM > 0 ? teamDoneTickets / teamTokensM : 0;

  // Second pass: derive per-user rates once the prior is known.
  Object.values(byUser).forEach(u => {
    const activeCount = u.activeDays.size;
    u.activeDaysCount = activeCount;
    u.promptsPerActiveDay = activeCount > 0 ? u.prompts / activeCount : 0;
    u.activeDaysPerWeek = windowWeeks > 0 ? activeCount / windowWeeks : 0;
    // Monthly-normalized volume drives the display floor for any window length.
    u.tokensPerMonth = windowDays > 0 ? (u.tokens * 30) / windowDays : 0;
    u.meetsVolumeFloor = u.tokensPerMonth >= minTokensPerMonth;
    const tokM = u.tokens / 1e6;
    // Raw ratios (surfaced in the tooltip for transparency) …
    u.spPerMillionTokensRaw = tokM > 0 ? u.sp / tokM : 0;
    u.doneSpPerMillionTokensRaw = tokM > 0 ? u.doneSp / tokM : 0;
    u.doneTicketsPerMillionTokensRaw = tokM > 0 ? u.doneTickets / tokM : 0;
    // … and shrunk ratios (shown as the primary number).
    u.spPerMillionTokens = (u.sp + priorSpRate * priorM) / (tokM + priorM);
    u.doneSpPerMillionTokens = (u.doneSp + priorDoneSpRate * priorM) / (tokM + priorM);
    u.doneTicketsPerMillionTokens = (u.doneTickets + priorDoneTixRate * priorM) / (tokM + priorM);
  });

  return { rows: Object.values(byUser), windowDays, windowWeeks,
    priorSpRate, priorDoneSpRate, priorDoneTixRate, minTokensPerMonth, priorM };
}

function renderAdoption(sessions, from, to) {
  const cfg = raw.adoption || { min_prompts_per_day: 30, min_active_days_per_week: 4, jira_available: false, jira_reason: 'unknown' };
  document.getElementById('adoption-goal-ppd').textContent = cfg.min_prompts_per_day;
  document.getElementById('adoption-goal-adw').textContent = cfg.min_active_days_per_week;

  const banner = document.getElementById('adoption-banner');
  const reasons = {
    'cache-missing': 'Story points column unavailable: no Jira cache yet. Run <code>npm run jira:refresh</code> on a machine with <code>ATLASSIAN_JIRA_API_TOKEN</code> set, then commit <code>.ai-memory/jira-story-points.json</code> so teammates see the same data.',
    'no-tickets': '',
  };
  banner.innerHTML = '';
  if (!cfg.jira_available) {
    const msg = reasons[cfg.jira_reason] || ('Story points unavailable: ' + escapeHtml(cfg.jira_reason || 'unknown'));
    if (msg) {
      banner.insertAdjacentHTML('beforeend', msg);
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  } else {
    banner.style.display = 'none';
  }

  const { rows, windowWeeks, minTokensPerMonth, priorM } = aggregateAdoption(sessions, from, to);
  const floorM = (minTokensPerMonth / 1e6).toFixed(0);
  const floorEl = document.getElementById('adoption-goal-floor');
  if (floorEl) floorEl.textContent = floorM;
  // The "Done SP" column is only meaningful once the cache carries status data.
  // Older caches predate the done flag entirely — detect that so we render a
  // helpful "—" instead of a misleading 0 for everyone.
  const spData = raw.story_points || {};
  const hasStatusData = Object.values(spData).some(e => e && e.done !== undefined);
  const tbody = document.querySelector('#adoption-table tbody');
  tbody.innerHTML = '';
  if (rows.length === 0) {
    tbody.insertAdjacentHTML('beforeend', '<tr><td colspan="7" class="empty-msg">No data for selected period</td></tr>');
    return;
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  const html = rows.map(u => {
    const ppdClass = u.promptsPerActiveDay >= cfg.min_prompts_per_day ? 'cost-lo' : 'cost-hi';
    const adwClass = u.activeDaysPerWeek >= cfg.min_active_days_per_week ? 'cost-lo' : 'cost-hi';
    const ppdTitle = u.prompts + ' prompts / ' + u.activeDaysCount + ' active days';
    const adwTitle = u.activeDaysCount + ' active days / ' + windowWeeks.toFixed(2) + ' weeks';
    // Below the monthly volume floor, the ratio is too noisy to rank on — blank
    // it (a small "n tokens/mo" hint stays so it's clear WHY, not just missing).
    // Above the floor we show the shrunk ratio; the tooltip carries the raw
    // ratio, the sample size (n tickets), and the shrinkage note for auditability.
    const belowFloor = '<td class="num muted" title="Below the ' + floorM + 'M tokens/mo floor (' + fmt(Math.round(u.tokensPerMonth)) + '/mo) — ratio too noisy to rank">— <span style="opacity:.5">low vol</span></td>';
    const ratioCell = (shrunk, raw, n, label) =>
      '<td class="num" title="' + n + ' ' + label + ' · raw ' + raw.toFixed(2) + ' (' + u.sp + ' SP ÷ ' + fmt(u.tokens) + ' tokens × 1M), shrunk toward team mean with ' + priorM + 'M prior">'
      + shrunk.toFixed(2) + ' <span class="muted" style="font-size:0.72em">(n=' + n + ')</span></td>';
    const spCell = !cfg.jira_available
      ? '<td class="num muted">—</td>'
      : (u.meetsVolumeFloor
          ? ratioCell(u.spPerMillionTokens, u.spPerMillionTokensRaw, u.spTickets, 'tickets')
          : belowFloor);
    const doneCell = !(cfg.jira_available && hasStatusData)
      ? '<td class="num muted" title="Refresh the SP cache (npm run jira:refresh) to populate ticket status">—</td>'
      : (u.meetsVolumeFloor
          ? ratioCell(u.doneSpPerMillionTokens, u.doneSpPerMillionTokensRaw, u.doneTickets, 'done tickets')
          : belowFloor);
    // SP-independent efficiency: delivered (Done) tickets per 1M tokens. Counts
    // unpointed Done tickets that the SP columns miss.
    const doneTixCell = !(cfg.jira_available && hasStatusData)
      ? '<td class="num muted" title="Refresh the SP cache (npm run jira:refresh) to populate ticket status">—</td>'
      : (u.meetsVolumeFloor
          ? ratioCell(u.doneTicketsPerMillionTokens, u.doneTicketsPerMillionTokensRaw, u.doneTickets, 'done tickets')
          : belowFloor);
    return '<tr>'
      + '<td>' + escapeHtml(u.user) + '</td>'
      + '<td class="num ' + ppdClass + '" title="' + ppdTitle + '">' + u.promptsPerActiveDay.toFixed(1) + '</td>'
      + '<td class="num ' + adwClass + '" title="' + adwTitle + '">' + u.activeDaysPerWeek.toFixed(1) + '</td>'
      + '<td class="num">' + fmt(u.tokens) + '</td>'
      + spCell
      + doneCell
      + doneTixCell
      + '</tr>';
  }).join('');
  tbody.insertAdjacentHTML('beforeend', html);
}

const AI_SP_SCALE = [0.5, 1, 2, 3, 5, 8, 13];
// Nearest index on the SP scale, snapping off-scale values so "within one step"
// is always well-defined.
function scaleIndex(v) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < AI_SP_SCALE.length; i++) {
    const diff = Math.abs(AI_SP_SCALE[i] - v);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

// MAE + hit rate over tickets carrying BOTH a human SP > 0 and an AI SP > 0.
function computeAiAccuracy() {
  const spByTicket = raw.story_points || {};
  const aiByTicket = (raw.ai_estimates && raw.ai_estimates.byTicket) || {};
  let absErr = 0, hits = 0, n = 0;
  for (const [tk, ai] of Object.entries(aiByTicket)) {
    if (!ai || !(ai.ai_sp > 0)) continue;
    const sp = spByTicket[tk];
    if (!sp || sp.error || !(sp.sp > 0)) continue;
    const aiSp = Number(ai.ai_sp), humanSp = Number(sp.sp);
    absErr += Math.abs(aiSp - humanSp);
    if (Math.abs(scaleIndex(aiSp) - scaleIndex(humanSp)) <= 1) hits++;
    n++;
  }
  if (n === 0) return { n: 0, mae: 0, hitRate: 0 };
  return { n, mae: absErr / n, hitRate: hits / n };
}

function renderAiAccuracy() {
  const minSample = (raw.ai_estimates && raw.ai_estimates.minSample) || 2;
  document.getElementById('ai-accuracy-min').textContent = minSample;
  const grid = document.getElementById('ai-accuracy-cards');
  const { n, mae, hitRate } = computeAiAccuracy();
  if (n < minSample) {
    grid.innerHTML = '<div class="empty-msg">Insufficient data: ' + n + ' comparable ticket(s), need ≥ ' + minSample + '. Numbers appear once enough tickets carry both a human SP and an AI estimate.</div>';
    return;
  }
  const cards = [
    { label: 'MAE', value: mae.toFixed(2), detail: 'Mean |AI SP − human SP|' },
    { label: 'Hit Rate', value: (hitRate * 100).toFixed(0) + '%', detail: 'Within one step on the SP scale' },
    { label: 'Sample', value: String(n), detail: 'Tickets with both AI + human SP' },
  ];
  grid.innerHTML = cards.map(c =>
    '<div class="card"><div class="card-label">'+escapeHtml(c.label)+'</div><div class="card-value">'+escapeHtml(c.value)+'</div><div class="card-detail">'+escapeHtml(c.detail)+'</div></div>'
  ).join('');
}

// Return the active-day buckets for a session that fall in [from, to].
// Falls back to a single virtual day at s.ts with whole-session totals for
// legacy data (no per-day deltas emitted by the server).
function activeDaysInRange(s, from, to) {
  const days = Array.isArray(s.active_days) && s.active_days.length > 0
    ? s.active_days
    : [{
        date: s.ts,
        prompts: s.prompts || 0,
        cost_usd: s.cost_usd || 0,
        input_tokens: s.input_tokens || 0,
        output_tokens: s.output_tokens || 0,
        cache_read_tokens: s.cache_read_tokens || 0,
        cache_creation_tokens: s.cache_creation_tokens || 0,
        lines_added: s.lines_added || 0,
        lines_removed: s.lines_removed || 0,
      }];
  return days.filter(d => d.date >= from && d.date <= to);
}

function sessionTouchesRange(s, from, to) {
  return activeDaysInRange(s, from, to).length > 0;
}

function emptyBucket() {
  return { input_tokens:0, output_tokens:0, cache_read:0, cache_create:0, cost_usd:0, cost_billed_usd:0, cost_estimated_usd:0, sessions:0, interactive_sessions:0, auxiliary_sessions:0, prompts:0, lines_added:0, lines_removed:0 };
}

function dayDeltas(d, ratio, costEstimated) {
  const dayCost = d.cost_usd || 0;
  return {
    input_tokens: d.input_tokens || 0,
    output_tokens: d.output_tokens || 0,
    cache_read: d.cache_read_tokens || 0,
    cache_create: d.cache_creation_tokens || 0,
    cost_usd: dayCost,
    cost_billed_usd: dayCost * ratio,
    cost_estimated_usd: costEstimated ? dayCost : 0,
    prompts: d.prompts || 0,
    lines_added: d.lines_added || 0,
    lines_removed: d.lines_removed || 0,
  };
}

function addInto(bucket, deltas, isInt) {
  bucket.input_tokens += deltas.input_tokens;
  bucket.output_tokens += deltas.output_tokens;
  bucket.cache_read += deltas.cache_read;
  bucket.cache_create += deltas.cache_create;
  bucket.cost_usd += deltas.cost_usd;
  bucket.cost_billed_usd += deltas.cost_billed_usd;
  bucket.cost_estimated_usd += deltas.cost_estimated_usd;
  bucket.sessions += 1;
  bucket.interactive_sessions += isInt ? 1 : 0;
  bucket.auxiliary_sessions += isInt ? 0 : 1;
  bucket.prompts += deltas.prompts;
  bucket.lines_added += deltas.lines_added;
  bucket.lines_removed += deltas.lines_removed;
}

function sumDeltas(parts) {
  const total = {
    input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0,
    cost_usd: 0, cost_billed_usd: 0, cost_estimated_usd: 0,
    prompts: 0, lines_added: 0, lines_removed: 0,
  };
  for (const p of parts) {
    for (const k of Object.keys(total)) total[k] += p[k];
  }
  return total;
}

function aggregate(sessions, from, to) {
  const byDay = {}, byUser = {}, byProject = {}, byTicket = {};
  const t = emptyBucket();
  sessions.forEach(s => {
    const days = activeDaysInRange(s, from, to);
    if (days.length === 0) return;
    const ticket = normalizeTicket(s.jira_ticket);
    const isInt = isInteractiveSession(s);
    const ratio = s.calibration_ratio != null ? s.calibration_ratio : 1.0;
    const perDay = days.map(d => dayDeltas(d, ratio, s.cost_estimated));
    // Daily buckets credit each active day; the totals roll up to the
    // session-scoped scopes (user/project/ticket/total) which must NOT
    // double-credit across days.
    for (let i = 0; i < days.length; i++) {
      if (!byDay[days[i].date]) byDay[days[i].date] = emptyBucket();
      addInto(byDay[days[i].date], perDay[i], isInt);
    }
    const inWindow = sumDeltas(perDay);
    if (!byUser[s.user]) byUser[s.user] = emptyBucket();
    if (!byProject[s.project]) byProject[s.project] = emptyBucket();
    if (!byTicket[ticket]) byTicket[ticket] = emptyBucket();
    addInto(byUser[s.user], inWindow, isInt);
    addInto(byProject[s.project], inWindow, isInt);
    addInto(byTicket[ticket], inWindow, isInt);
    addInto(t, inWindow, isInt);
  });
  const daily = Object.entries(byDay).map(([d,v]) => ({date:d,...v})).sort((a,b) => b.date.localeCompare(a.date));
  const users = Object.entries(byUser).map(([u,v]) => {
    // Recover per-user calibration ratio from any one of their sessions
    // (every session for the same user ships the same ratio from the server).
    const sample = sessions.find(s => s.user === u);
    const ratio = sample && sample.calibration_ratio != null ? sample.calibration_ratio : 1.0;
    return { user:u, ...v, calibration_ratio: ratio };
  }).sort((a,b) => b.cost_usd - a.cost_usd);
  const projects = Object.entries(byProject).map(([p,v]) => ({project:p,...v})).sort((a,b) => b.cost_usd - a.cost_usd);
  const tickets = Object.entries(byTicket).map(([k,v]) => ({ticket:k,...v})).sort((a,b) => b.cost_usd - a.cost_usd);
  return { total: t, daily, users, projects, tickets };
}

function render(range, monthVal) {
  const { from, to } = dateRange(range, monthVal);
  const periodFiltered = raw.sessions.filter(s => sessionTouchesRange(s, from, to));
  const filtered = periodFiltered.filter(sessionMatchesActive);
  const { total: t, daily, users, projects, tickets } = aggregate(filtered, from, to);

  document.getElementById('generated-at').textContent = 'Generated: ' + raw.generated_at + '  |  Showing: ' + from + ' to ' + to;

  const grid = document.getElementById('summary-cards');
  grid.innerHTML = '';
  const billableInput = (t.input_tokens || 0) + (t.cache_create || 0);
  const netLines = (t.lines_added || 0) - (t.lines_removed || 0);
  const cards = [
    { label: 'Interactive Sessions', value: t.interactive_sessions, detail: '≥2 prompts; real work' },
    { label: 'Auxiliary Runs', value: t.auxiliary_sessions, detail: 'Subagents, /loop, headless' },
    { label: 'Input Tokens', value: fmt(t.input_tokens), detail: 'Raw input (non-cached)' },
    { label: 'Cache Creation', value: fmt(t.cache_create || 0), detail: 'Billable cache writes' },
    { label: 'Billable Input', value: fmt(billableInput), detail: 'Raw + cache creation' },
    { label: 'Output Tokens', value: fmt(t.output_tokens), detail: 'Generated output' },
    { label: 'Cache Reads', value: fmt(t.cache_read), detail: 'Saved via caching' },
    { label: 'Lines Changed', value: fmt(t.lines_added) + ' / ' + fmt(t.lines_removed), detail: (netLines >= 0 ? '+' : '') + fmt(netLines) + ' net' },
    { label: 'List-Price Value', value: '$' + t.cost_usd.toFixed(2), detail: 'tokens × list rates — not the invoice' },
    { label: 'Avg Cost/Interactive', value: '$' + (t.interactive_sessions ? (t.cost_usd / t.interactive_sessions).toFixed(2) : '0.00'), detail: 'Per real session' },
  ];
  if (t.cost_billed_usd != null && t.cost_billed_usd !== t.cost_usd) {
    cards.push({
      label: 'Billed (est.)',
      value: '$' + t.cost_billed_usd.toFixed(2),
      detail: 'sum of per-user calibrated costs'
    });
  }
  const cardHtml = filtered.length === 0
    ? '<div class="empty-msg">No data for selected period</div>'
    : cards.map(c =>
        '<div class="card"><div class="card-label">'+escapeHtml(c.label)+'</div><div class="card-value">'+escapeHtml(c.value)+'</div><div class="card-detail">'+escapeHtml(c.detail)+'</div></div>'
      ).join('');
  grid.insertAdjacentHTML('beforeend', cardHtml);

  const dtb = document.querySelector('#daily-table tbody');
  dtb.innerHTML = '';
  if (daily.length === 0) { dtb.innerHTML = '<tr><td colspan="11" class="empty-msg">No data for selected period</td></tr>'; }
  else {
    const maxTok = Math.max(...daily.map(d => d.input_tokens + d.output_tokens + (d.cache_read||0)), 1);
    const dailyRows = daily.map(d => {
      const inW = Math.max(1, (d.input_tokens/maxTok)*200);
      const outW = Math.max(1, (d.output_tokens/maxTok)*200);
      const crW = ((d.cache_read||0)/maxTok)*200;
      return '<tr><td class="num">'+d.date+'</td><td class="num">'+(d.interactive_sessions||0)+'</td><td class="num muted">'+(d.auxiliary_sessions||0)+'</td><td class="num">'+d.prompts+'</td><td class="num">'+fmt(d.input_tokens)+'</td><td class="num">'+fmt(d.output_tokens)+'</td><td class="num">'+fmt(d.cache_read||0)+'</td><td class="num lines-add">+'+fmt(d.lines_added||0)+'</td><td class="num lines-rem">-'+fmt(d.lines_removed||0)+'</td><td class="num '+costClass(d.cost_usd)+'">$'+d.cost_usd.toFixed(2)+'</td><td class="bar-cell"><span class="bar bar-in" style="width:'+inW+'px"></span><span class="bar bar-out" style="width:'+outW+'px"></span>'+(crW>0?'<span class="bar bar-cache" style="width:'+crW+'px"></span>':'')+'</td></tr>';
    });
    dtb.insertAdjacentHTML('beforeend', dailyRows.join(''));
  }

  const utb = document.querySelector('#user-table tbody');
  utb.innerHTML = '';
  if (users.length === 0) { utb.innerHTML = '<tr><td colspan="12" class="empty-msg">No data for selected period</td></tr>'; }
  else {
    const aiSpByUser = aiSpCreditedByUser(filtered, from, to);
    const userRows = users.map(u => {
      const pct = estPct(u);
      const billedCell = (u.cost_billed_usd != null && u.calibration_ratio && u.calibration_ratio !== 1.0)
        ? '<td class="num" title="ratio '+u.calibration_ratio.toFixed(4)+'">$'+u.cost_billed_usd.toFixed(2)+'</td>'
        : '<td class="num muted">-</td>';
      const aiSp1m = aiSpByUser[u.user] || 0;
      const aiSpCell = aiSp1m > 0
        ? '<td class="num" title="(AI SP credited × 1,000,000) ÷ tokens">'+aiSp1m.toFixed(2)+'</td>'
        : '<td class="num muted">—</td>';
      return '<tr><td>'+escapeHtml(u.user)+'</td><td class="num">'+(u.interactive_sessions||0)+'</td><td class="num muted">'+(u.auxiliary_sessions||0)+'</td><td class="num">'+u.prompts+'</td><td class="num">'+fmt(u.input_tokens)+'</td><td class="num">'+fmt(u.output_tokens)+'</td><td class="num lines-add">+'+fmt(u.lines_added||0)+'</td><td class="num lines-rem">-'+fmt(u.lines_removed||0)+'</td><td class="num '+costClass(u.cost_usd)+'">$'+u.cost_usd.toFixed(2)+'</td>'+billedCell+'<td class="num '+estClass(pct)+'">'+pct.toFixed(1)+'%</td>'+aiSpCell+'</tr>';
    });
    utb.insertAdjacentHTML('beforeend', userRows.join(''));
  }

  const ptb = document.querySelector('#project-table tbody');
  ptb.innerHTML = '';
  if (projects.length === 0) { ptb.innerHTML = '<tr><td colspan="10" class="empty-msg">No data for selected period</td></tr>'; }
  else {
    const projectRows = projects.map(p => {
      const pct = estPct(p);
      return '<tr><td>'+escapeHtml(p.project)+'</td><td class="num">'+(p.interactive_sessions||0)+'</td><td class="num muted">'+(p.auxiliary_sessions||0)+'</td><td class="num">'+p.prompts+'</td><td class="num">'+fmt(p.input_tokens)+'</td><td class="num">'+fmt(p.output_tokens)+'</td><td class="num lines-add">+'+fmt(p.lines_added||0)+'</td><td class="num lines-rem">-'+fmt(p.lines_removed||0)+'</td><td class="num '+costClass(p.cost_usd)+'">$'+p.cost_usd.toFixed(2)+'</td><td class="num '+estClass(pct)+'">'+pct.toFixed(1)+'%</td></tr>';
    });
    ptb.insertAdjacentHTML('beforeend', projectRows.join(''));
  }

  const ttb = document.querySelector('#ticket-table tbody');
  ttb.innerHTML = '';
  if (tickets.length === 0) { ttb.innerHTML = '<tr><td colspan="12" class="empty-msg">No data for selected period</td></tr>'; }
  else {
    const spByTicket = raw.story_points || {};
    const aiByTicket = (raw.ai_estimates && raw.ai_estimates.byTicket) || {};
    const ticketRows = tickets.map(tk => {
      const pct = estPct(tk);
      const label = tk.ticket === '(no ticket)'
        ? '<span class="muted">(no ticket)</span>'
        : jiraLink(tk.ticket);
      const spMeta = spByTicket[tk.ticket];
      let spCell;
      if (tk.ticket === '(no ticket)' || !spMeta || spMeta.error) {
        spCell = '<td class="num muted">-</td>';
      } else {
        const assigneeTitle = spMeta.assignee ? 'Story points (assignee: ' + escapeHtml(spMeta.assignee) + ')' : 'Story points';
        spCell = '<td class="num" title="'+assigneeTitle+'">'+Number(spMeta.sp || 0)+'</td>';
      }
      const aiMeta = aiByTicket[tk.ticket];
      let aiCell;
      if (tk.ticket === '(no ticket)' || !aiMeta || aiMeta.ai_sp == null) {
        aiCell = '<td class="num muted">—</td>';
      } else {
        const aiTitle = 'AI estimate (' + escapeHtml(aiMeta.basis || 'n/a') + ', ' + escapeHtml(aiMeta.estimator || 'unknown') + ')';
        aiCell = '<td class="num" title="'+aiTitle+'">'+Number(aiMeta.ai_sp)+'</td>';
      }
      return '<tr><td>'+label+'</td>'+spCell+aiCell+'<td class="num">'+(tk.interactive_sessions||0)+'</td><td class="num muted">'+(tk.auxiliary_sessions||0)+'</td><td class="num">'+tk.prompts+'</td><td class="num">'+fmt(tk.input_tokens)+'</td><td class="num">'+fmt(tk.output_tokens)+'</td><td class="num lines-add">+'+fmt(tk.lines_added||0)+'</td><td class="num lines-rem">-'+fmt(tk.lines_removed||0)+'</td><td class="num '+costClass(tk.cost_usd)+'">$'+tk.cost_usd.toFixed(2)+'</td><td class="num '+estClass(pct)+'">'+pct.toFixed(1)+'%</td></tr>';
    });
    ttb.insertAdjacentHTML('beforeend', ticketRows.join(''));
  }

  const stb = document.querySelector('#session-table tbody');
  stb.innerHTML = '';
  if (filtered.length === 0) { stb.innerHTML = '<tr><td colspan="13" class="empty-msg">No data for selected period</td></tr>'; }
  const sessionRows = filtered.map(s => {
    const tkNorm = normalizeTicket(s.jira_ticket);
    const ticket = (tkNorm === '(no ticket)') ? '-' : jiraLink(tkNorm);
    const taskFull = s.task ? escapeHtml(s.task) : '';
    const taskShort = s.task ? escapeHtml(s.task.slice(0,40)) + (s.task.length>40?'…':'') : '';
    const task = s.task ? '<span title="'+taskFull+'">'+taskShort+'</span>' : '-';
    const reconBadge = s.attribution_reconciled
      ? '<span class="reconciled-badge" title="Attribution reconciled by reconcile-session-attribution.sh — at least one event had project/jira_ticket rewritten to the primary value derived from transcript or majority vote. Originals preserved in the events file.">rec</span>'
      : '';
    return '<tr><td class="num">'+escapeHtml(s.session_id)+reconBadge+'</td><td class="num">'+escapeHtml(s.ts)+'</td><td>'+escapeHtml(s.user)+'</td><td>'+escapeHtml(s.project)+'</td><td>'+escapeHtml(s.model||'-')+'</td><td>'+ticket+'</td><td>'+task+'</td><td class="num">'+s.prompts+'</td><td class="num'+(s.rule_injections>0?'':' muted')+'" title="'+(s.rule_injection_events||0)+' rule-injection event(s)">'+(s.rule_injections>0?s.rule_injections:'-')+'</td><td class="num">'+fmt(s.input_tokens)+'</td><td class="num">'+fmt(s.output_tokens)+'</td><td class="num lines-add">+'+fmt(s.lines_added||0)+'</td><td class="num lines-rem">-'+fmt(s.lines_removed||0)+'</td><td class="num">'+fmtDuration(s.duration_min)+'</td><td class="num '+costClass(s.cost_usd)+'">$'+s.cost_usd.toFixed(2)+'</td></tr>';
  });
  stb.insertAdjacentHTML('beforeend', sessionRows.join(''));

  renderAdoption(filtered, from, to);
  renderDelivery(periodFiltered, from, to);
  renderUntracked(from, to);
  renderCrossTab(periodFiltered);
  renderAiLanded();
}

// ── Delivery, Velocity & ROI ────────────────────────────────────────────────
// Team-level. Joins the Jira delivered-universe (raw.delivered_tickets) with the
// AI-tracked ticket set (from sessions) and the team roster/baselines
// (raw.team_config) to surface velocity, AI coverage, cost/SP, and the pre-AI
// productivity multiplier — all honoring the selected time window.

function sp1(n) { return String(Math.round((n || 0) * 10) / 10); }

function deliveredInRange(from, to) {
  const dt = raw.delivered_tickets;
  if (!dt || !dt.available) return [];
  const out = [];
  const by = dt.byTicket || {};
  for (const key of Object.keys(by)) {
    const e = by[key];
    if (!e || !e.resolved) continue;
    if (e.resolved >= from && e.resolved <= to) out.push(Object.assign({ key: key }, e));
  }
  return out;
}

// Distinct Jira keys with at least one session touching the window (team-wide,
// ignores the active-user filter — coverage is a team question).
function aiTrackedTicketSet(from, to) {
  const set = new Set();
  raw.sessions.forEach(s => {
    if (!sessionTouchesRange(s, from, to)) return;
    const k = ticketKeyOf(s);
    if (k) set.add(k);
  });
  return set;
}

function computeDelivery(from, to) {
  const delivered = deliveredInRange(from, to);
  const aiKeys = aiTrackedTicketSet(from, to);
  // computeDeliveryMetrics is embedded verbatim from scripts/_lib/delivery-metrics.js.
  const m = computeDeliveryMetrics(delivered, aiKeys, raw.team_config || {}, { from, to });
  m.deliveredAvailable = !!(raw.delivered_tickets && raw.delivered_tickets.available);
  return m;
}

// One SP/FTE table row (shared by Team/BE/FE segments and per-developer rows).
function deliveryRow(label, s, cls) {
  const multCell = s.mult != null
    ? '<td class="num ' + (s.mult >= 1 ? 'lines-add' : 'cost-hi') + '">' + s.mult.toFixed(2) + '×</td>'
    : '<td class="num muted">—</td>';
  return '<tr class="' + (cls || '') + '"><td>' + escapeHtml(label) + '</td><td class="num">' + sp1(s.sp) + '</td><td class="num">' + s.fte.toFixed(2) + '</td>'
    + '<td class="num">' + (s.spFteMo != null ? sp1(s.spFteMo) : '—') + '</td>'
    + '<td class="num">' + (s.spFteDay != null ? s.spFteDay.toFixed(2) : '—') + '</td>'
    + '<td class="num muted">' + (s.base != null ? sp1(s.base) : '—') + '</td>'
    + multCell + '</tr>';
}

function renderDelivery(periodFiltered, from, to) {
  const section = document.getElementById('section-delivery');
  if (!section) return;
  const dt = raw.delivered_tickets;
  const winEl = document.getElementById('delivery-window');
  const cardsEl = document.getElementById('delivery-cards');
  const tbody = document.querySelector('#delivery-fte-table tbody');
  if (!dt || !dt.available) {
    winEl.innerHTML = 'Delivered-ticket cache unavailable — run <code>npm run jira:refresh-period</code> (needs Jira credentials), then commit <code>.ai-memory/jira-period-tickets.json</code>.';
    cardsEl.innerHTML = '';
    tbody.innerHTML = '';
    return;
  }
  const m = computeDelivery(from, to);
  const genWin = dt.window ? (' · universe: ' + dt.window.from + '→' + dt.window.to) : '';
  winEl.textContent = 'Delivered ' + m.delivered.length + ' tickets (' + sp1(m.totalSp) + ' SP) in window · ' + m.bizDays + ' business days' + genWin;
  paintDelivery(m);
}

function paintDelivery(m) {
  const cardsEl = document.getElementById('delivery-cards');
  const tbody = document.querySelector('#delivery-fte-table tbody');
  // A non-roster session user has no Jira mapping → roster-only velocity is n/a.
  if (activeSessionUser()) {
    cardsEl.innerHTML = '<div class="empty-msg">Delivery velocity is roster-only — no Jira mapping for “' + escapeHtml(activeSessionUser()) + '”. Token consumption for this user still shows in the sections below.</div>';
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">No roster mapping for the selected session user.</td></tr>';
    return;
  }
  // Scoped to the globally-selected roster member (person key = jira_name).
  const personKey = activePersonKey();
  const pd = personKey ? m.perDev.find(d => d.name === personKey) : null;

  const cards = pd
    ? [
        { label: 'SP Delivered', value: sp1(pd.sp), detail: pd.tickets + ' tickets · ' + pd.role },
        { label: 'SP / week', value: sp1(pd.spWeek), detail: 'over ' + sp1(m.weeks) + ' weeks' },
        { label: 'SP / month', value: sp1(pd.spMonth), detail: 'normalized (30-day)' },
        { label: 'AI Coverage', value: pd.coverage.toFixed(0) + '%', detail: pd.tracked + '/' + pd.tickets + ' tickets · ' + pd.untracked + ' untracked' },
      ]
    : [
        { label: 'SP Delivered', value: sp1(m.totalSp), detail: m.delivered.length + ' tickets Done in window' },
        { label: 'SP / week', value: sp1(m.spWeek), detail: 'over ' + sp1(m.weeks) + ' weeks' },
        { label: 'SP / month', value: sp1(m.spMonth), detail: 'normalized (30-day)' },
        { label: 'AI Coverage', value: m.coverageCount.toFixed(0) + '%', detail: m.tracked.length + '/' + m.delivered.length + ' tickets · ' + sp1(m.untrackedSp) + ' SP untracked' },
      ];
  if (pd && pd.mult != null) {
    cards.push({ label: 'vs Pre-AI SP/FTE', value: pd.mult.toFixed(2) + '×', detail: sp1(pd.spFteMo) + ' vs ' + sp1(pd.base) + ' SP/FTE/mo' });
  } else if (!pd && m.segments[0] && m.segments[0].mult != null) {
    const teamSeg = m.segments[0];
    cards.push({ label: 'vs Pre-AI SP/FTE', value: teamSeg.mult.toFixed(2) + '×', detail: sp1(teamSeg.spFteMo) + ' vs ' + sp1(teamSeg.base) + ' SP/FTE/mo' });
  }
  cardsEl.innerHTML = cards.map(c =>
    '<div class="card"><div class="card-label">' + escapeHtml(c.label) + '</div><div class="card-value">' + escapeHtml(c.value) + '</div><div class="card-detail">' + escapeHtml(c.detail) + '</div></div>'
  ).join('');

  if (!m.cfgAvailable) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">Team roster unavailable (could not parse .claude/commands/team-report.md)</td></tr>';
    return;
  }
  if (pd) {
    tbody.innerHTML = deliveryRow(pd.name + ' · ' + pd.role, pd);
    return;
  }
  // Team/BE/FE segments, then a per-developer breakdown.
  const segRows = m.segments.map(s => deliveryRow(s.label, s)).join('');
  const devRows = m.perDev.length
    ? '<tr><td colspan="7" class="muted" style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.5px;">Per developer</td></tr>'
      + m.perDev.map(dv => deliveryRow(dv.name + ' · ' + dv.role, dv, 'muted-name')).join('')
    : '';
  tbody.innerHTML = segRows + devRows;
}

function renderUntracked(from, to) {
  const section = document.getElementById('section-untracked');
  if (!section) return;
  const dt = raw.delivered_tickets;
  if (!dt || !dt.available) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  const delivered = deliveredInRange(from, to);
  const aiKeys = aiTrackedTicketSet(from, to);
  const untrackedAll = delivered.filter(d => !aiKeys.has(d.key))
    .sort((a, b) => (Number(b.sp) || 0) - (Number(a.sp) || 0));
  paintUntracked(from, to, delivered, untrackedAll);
}

function paintUntracked(from, to, delivered, untrackedAll) {
  const banner = document.getElementById('untracked-banner');
  const tbody = document.querySelector('#untracked-table tbody');
  // A non-roster session user has no Jira assignee mapping → show empty.
  if (activeSessionUser()) {
    banner.innerHTML = 'Untracked tickets are matched by Jira assignee — no mapping for the session user “' + escapeHtml(activeSessionUser()) + '”.';
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No roster mapping for the selected session user.</td></tr>';
    return;
  }
  // Scoped to the globally-selected roster member: match by their Jira name variants.
  const personKey = activePersonKey();
  const jiraNames = personKey ? jiraNamesForKey(personKey) : null;
  const activeLabel = personKey || '';
  const rows = jiraNames
    ? untrackedAll.filter(d => jiraNames.has(d.assignee))
    : untrackedAll;
  const untrackedSp = untrackedAll.reduce((a, d) => a + (Number(d.sp) || 0), 0);
  const shownSp = rows.reduce((a, d) => a + (Number(d.sp) || 0), 0);
  const cov = delivered.length ? (((delivered.length - untrackedAll.length) / delivered.length) * 100).toFixed(0) : '0';
  if (jiraNames) {
    banner.innerHTML = '<strong>' + rows.length + '</strong> untracked ticket(s) for <strong>'
      + escapeHtml(activeLabel) + '</strong> (<strong>' + sp1(shownSp) + '</strong> SP) — of '
      + untrackedAll.length + ' untracked team-wide (' + cov + '% AI coverage).';
  } else {
    banner.innerHTML = '<strong>' + untrackedAll.length + '</strong> of ' + delivered.length
      + ' delivered tickets had no AI session (<strong>' + cov + '%</strong> AI coverage, <strong>'
      + sp1(untrackedSp) + '</strong> SP shipped without the workspace AI).';
  }
  if (rows.length === 0) {
    const msg = untrackedAll.length === 0
      ? 'Every delivered ticket in this window has an AI session — 100% coverage.'
      : 'No untracked tickets for this team member in the window.';
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">' + msg + '</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(d => {
    const sumFull = d.summary ? escapeHtml(d.summary) : '';
    const sumShort = d.summary ? (escapeHtml(d.summary.slice(0, 60)) + (d.summary.length > 60 ? '…' : '')) : '-';
    return '<tr><td>' + jiraLink(d.key) + '</td>'
      + '<td><span title="' + sumFull + '">' + sumShort + '</span></td>'
      + '<td>' + escapeHtml(d.assignee || '-') + '</td>'
      + '<td>' + escapeHtml(d.type || '-') + '</td>'
      + '<td class="num">' + (d.sp ? sp1(d.sp) : '-') + '</td>'
      + '<td class="num">' + escapeHtml(d.resolved || '-') + '</td></tr>';
  }).join('');
}

// AI Code Landed → Cost. Filter-independent (weekly delivery snapshots), team-level only.
function renderAiLanded() {
  const section = document.getElementById('section-ai-landed');
  const al = raw.ai_landed;
  if (!section) return;
  if (!al || !al.available) { section.style.display = 'none'; return; }
  section.style.display = '';
  const w = al.latest;
  const win = w.window ? (w.window.start + ' – ' + w.window.end) : 'latest week';
  document.getElementById('ai-landed-window').textContent = 'Latest delivery week: ' + win;
  const cards = [
    { label: 'AI-landed share', value: (w.ai_landed_pct != null ? w.ai_landed_pct + '%' : 'n/a'), detail: 'of hand-written lines to master/release' },
    { label: 'AI-landed lines', value: fmt(w.ai_landed_lines || 0), detail: 'of ' + fmt(w.landed_lines || 0) + ' shipped' },
    { label: 'AI spend (week)', value: '$' + fmt(Math.round(w.ai_cost || 0)), detail: 'API-equivalent · team' },
    { label: '$ / 1k AI-landed lines', value: (w.cost_per_kloc != null ? '$' + w.cost_per_kloc : 'n/a'), detail: 'cost → shipped output' },
  ];
  document.getElementById('ai-landed-cards').innerHTML = cards.map((c) =>
    '<div class="card"><div class="card-label">' + escapeHtml(c.label) + '</div><div class="card-value">' + escapeHtml(c.value) + '</div><div class="card-detail">' + escapeHtml(c.detail) + '</div></div>'
  ).join('');
}

function buildCrossTab(sessions) {
  const userSet = new Set(sessions.map(s => s.user));
  const users = [...userSet].sort();
  const daySet = new Set(sessions.map(s => s.ts));
  const days = [...daySet].sort().reverse();
  const byDayUser = {};
  sessions.forEach(s => {
    const k = s.ts + '\\x00' + s.user;
    if (!byDayUser[k]) byDayUser[k] = { cost: 0, prompts: 0 };
    byDayUser[k].cost += s.cost_usd;
    byDayUser[k].prompts += s.prompts;
  });
  return { users, days, byDayUser };
}

function renderCrossTab(sessions) {
  const thead = document.querySelector('#daily-user-table thead');
  const tbody = document.querySelector('#daily-user-table tbody');
  if (!sessions.length) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="empty-msg">No data for selected period</td></tr>';
    return;
  }
  const { users, days, byDayUser } = buildCrossTab(sessions);
  const shortName = u => u.includes('@') ? u.split('@')[0] : u;
  thead.innerHTML = '<tr><th>Date</th>' + users.map(u => '<th>' + shortName(u) + '</th>').join('') + '<th>Total</th></tr>';
  const userTotals = {};
  users.forEach(u => { userTotals[u] = 0; });
  const rows = days.map(day => {
    let rowTotal = 0;
    const cells = users.map(u => {
      const v = byDayUser[day + '\\x00' + u];
      const c = v ? v.cost : 0;
      rowTotal += c;
      userTotals[u] += c;
      return c > 0 ? '<td class="num ' + costClass(c) + '">$' + c.toFixed(2) + '</td>' : '<td class="num muted">-</td>';
    });
    return '<tr><td class="num">' + day + '</td>' + cells.join('') + '<td class="num ' + costClass(rowTotal) + '"><strong>$' + rowTotal.toFixed(2) + '</strong></td></tr>';
  });
  const grandTotal = users.reduce((s, u) => s + userTotals[u], 0);
  const totalCells = users.map(u => '<td class="num ' + costClass(userTotals[u]) + '">$' + userTotals[u].toFixed(2) + '</td>');
  rows.push('<tr class="total-row"><td class="num">Total</td>' + totalCells.join('') + '<td class="num ' + costClass(grandTotal) + '">$' + grandTotal.toFixed(2) + '</td></tr>');
  tbody.innerHTML = rows.join('');
}

const months = [...new Set(raw.sessions.map(s => s.ts.slice(0, 7)))].sort().reverse();
const picker = document.getElementById('month-picker');
months.forEach(m => {
  const opt = document.createElement('option');
  opt.value = m;
  opt.textContent = m;
  picker.appendChild(opt);
});

// ── Roster-based team-member identity (single "who" filter) ──────────────────
// One selector drives every section. buildTeamIdentity (embedded from
// scripts/_lib/team-identity.js) bridges three identity spaces that don't line up
// on their own: session/git usernames (s.user), the roster's short name, and Jira
// assignee display names (+ variants via team-aliases.json). The person key is the
// canonical Jira display name (roster.jira_name).
const teamRoster = (raw.team_config && raw.team_config.available && Array.isArray(raw.team_config.roster)) ? raw.team_config.roster : [];
const jiraAliases = (raw.team_config && raw.team_config.jira_aliases) || {};
const rosterMode = teamRoster.length > 0;
const teamIdentity = buildTeamIdentity(teamRoster, jiraAliases);
function personKeyForSessionUser(u) { return teamIdentity.personKeyForSessionUser(u); }
function jiraNamesForKey(key) { return teamIdentity.jiraNamesForKey(key); }

// The filter value is prefixed so one control can select either a roster person
// ("person:<jira_name>" → drives every section) or a raw non-roster session user
// ("user:<s.user>" → drives only the token/consumption tables; the roster-only
// delivery & untracked tables render empty for them).
function activePersonKey() { return activeUser.startsWith('person:') ? activeUser.slice(7) : ''; }
function activeSessionUser() { return activeUser.startsWith('user:') ? activeUser.slice(5) : ''; }
function sessionMatchesActive(s) {
  if (!activeUser) return true;
  if (activeUser.startsWith('person:')) return personKeyForSessionUser(s.user) === activePersonKey();
  if (activeUser.startsWith('user:')) return s.user === activeSessionUser();
  return true;
}

const userPicker = document.getElementById('user-filter');
(function populateUserPicker() {
  const mkOpt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
  // Roster members (drive every section).
  if (rosterMode) {
    const g = document.createElement('optgroup');
    g.label = 'Team (roster)';
    teamRoster.slice().sort((a, b) => a.jira_name.localeCompare(b.jira_name))
      .forEach(r => g.appendChild(mkOpt('person:' + r.jira_name, r.jira_name + ' · ' + r.role)));
    userPicker.appendChild(g);
  }
  // Every session user NOT resolved to a roster person — kept so their token
  // consumption stays filterable (roster-only sections show empty for them).
  const others = [...new Set(raw.sessions.map(s => s.user))]
    .filter(u => !(rosterMode && personKeyForSessionUser(u)))
    .sort();
  if (others.length) {
    const g = document.createElement('optgroup');
    g.label = rosterMode ? 'Other session users' : 'Session users';
    others.forEach(u => g.appendChild(mkOpt('user:' + u, u.includes('@') ? u.split('@')[0] : u)));
    userPicker.appendChild(g);
  }
})();

function currentSlice() {
  const monthVal = picker.value || '';
  const range = monthVal ? 'month' : activeRange;
  const { from, to } = dateRange(range, monthVal);
  const periodFiltered = raw.sessions.filter(s => sessionTouchesRange(s, from, to));
  const filtered = periodFiltered.filter(sessionMatchesActive);
  const agg = aggregate(filtered, from, to);
  return { filtered, daily: agg.daily, users: agg.users, projects: agg.projects, from, to, label: monthVal || range };
}

const periodButtons = () => document.querySelectorAll('.filter-btn[data-range]');

let activeRange = '7d';
let activeUser = '';

const fromInput = document.getElementById('from-date');
const toInput = document.getElementById('to-date');

// Bound the pickable dates to the data window so users can't page to empty months.
const allDates = raw.sessions.map(s => s.ts.slice(0, 10)).filter(Boolean).sort();
if (allDates.length) {
  fromInput.min = toInput.min = allDates[0];
  fromInput.max = toInput.max = today;
}

// Clear the custom range's visual state without re-rendering (caller renders next).
function clearCustomRange() {
  customFrom = '';
  customTo = '';
  fromInput.value = '';
  toInput.value = '';
  fromInput.classList.remove('active');
  toInput.classList.remove('active');
}

periodButtons().forEach(btn => {
  btn.addEventListener('click', () => {
    periodButtons().forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeRange = btn.dataset.range;
    picker.value = '';
    clearCustomRange();
    render(activeRange, '');
  });
});
picker.addEventListener('change', () => {
  if (picker.value) {
    periodButtons().forEach(b => b.classList.remove('active'));
    clearCustomRange();
    render('month', picker.value);
  }
});

// A custom range is mutually exclusive with the presets/month — selecting one
// deactivates the others so there's a single source of truth for {from, to}.
function applyCustomRange() {
  customFrom = fromInput.value || '';
  customTo = toInput.value || '';
  if (!customFrom && !customTo) { // both cleared → fall back to default preset
    activeRange = '7d';
    periodButtons().forEach(b => b.classList.toggle('active', b.dataset.range === '7d'));
    render(activeRange, '');
    return;
  }
  activeRange = 'custom';
  periodButtons().forEach(b => b.classList.remove('active'));
  picker.value = '';
  fromInput.classList.toggle('active', !!customFrom);
  toInput.classList.toggle('active', !!customTo);
  render('custom', '');
}
fromInput.addEventListener('change', applyCustomRange);
toInput.addEventListener('change', applyCustomRange);
document.getElementById('range-clear').addEventListener('click', () => {
  clearCustomRange();
  activeRange = '7d';
  picker.value = '';
  periodButtons().forEach(b => b.classList.toggle('active', b.dataset.range === '7d'));
  render(activeRange, '');
});
userPicker.addEventListener('change', () => {
  activeUser = userPicker.value;
  const monthVal = picker.value || '';
  render(monthVal ? 'month' : activeRange, monthVal);
});

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\\n\\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\\n') + '\\n';
}
function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportStamp() {
  return new Date().toISOString().slice(0, 10);
}
function fnamePrefix(slice) {
  const { from, to, label } = slice;
  const periodTag = (label && label !== '7d' && label !== 'all') ? label : (from + '_to_' + to);
  return 'tokens_' + periodTag + '_' + exportStamp();
}

document.getElementById('export-daily').addEventListener('click', () => {
  const s = currentSlice();
  const headers = ['date', 'interactive_sessions', 'auxiliary_sessions', 'sessions_total', 'prompts', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'lines_added', 'lines_removed', 'cost_usd'];
  const rows = s.daily.map(d => [d.date, d.interactive_sessions || 0, d.auxiliary_sessions || 0, d.sessions, d.prompts, d.input_tokens, d.output_tokens, d.cache_read || 0, d.lines_added || 0, d.lines_removed || 0, d.cost_usd.toFixed(2)]);
  downloadCsv(fnamePrefix(s) + '_daily.csv', toCsv(headers, rows));
});
document.getElementById('export-users').addEventListener('click', () => {
  const s = currentSlice();
  const headers = ['user', 'interactive_sessions', 'auxiliary_sessions', 'sessions_total', 'prompts', 'input_tokens', 'output_tokens', 'lines_added', 'lines_removed', 'cost_usd', 'cost_estimated_usd'];
  const rows = s.users.map(u => [u.user, u.interactive_sessions || 0, u.auxiliary_sessions || 0, u.sessions, u.prompts, u.input_tokens, u.output_tokens, u.lines_added || 0, u.lines_removed || 0, u.cost_usd.toFixed(2), (u.cost_estimated_usd||0).toFixed(2)]);
  downloadCsv(fnamePrefix(s) + '_users.csv', toCsv(headers, rows));
});
document.getElementById('export-projects').addEventListener('click', () => {
  const s = currentSlice();
  const headers = ['project', 'interactive_sessions', 'auxiliary_sessions', 'sessions_total', 'prompts', 'input_tokens', 'output_tokens', 'lines_added', 'lines_removed', 'cost_usd', 'cost_estimated_usd'];
  const rows = s.projects.map(p => [p.project, p.interactive_sessions || 0, p.auxiliary_sessions || 0, p.sessions, p.prompts, p.input_tokens, p.output_tokens, p.lines_added || 0, p.lines_removed || 0, p.cost_usd.toFixed(2), (p.cost_estimated_usd||0).toFixed(2)]);
  downloadCsv(fnamePrefix(s) + '_projects.csv', toCsv(headers, rows));
});
document.getElementById('export-sessions').addEventListener('click', () => {
  const s = currentSlice();
  const headers = ['session_id', 'date', 'user', 'project', 'jira_ticket', 'task', 'prompts', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'lines_added', 'lines_removed', 'duration_min', 'cost_usd'];
  const rows = s.filtered.map(x => [x.session_id, x.ts, x.user, x.project, x.jira_ticket || '', x.task || '', x.prompts, x.input_tokens, x.output_tokens, x.cache_read_tokens || 0, x.cache_creation_tokens || 0, x.lines_added || 0, x.lines_removed || 0, x.duration_min || 0, x.cost_usd.toFixed(2)]);
  downloadCsv(fnamePrefix(s) + '_sessions.csv', toCsv(headers, rows));
});
document.getElementById('export-all').addEventListener('click', () => {
  const s = currentSlice();
  const headers = ['section', 'key', 'interactive_sessions', 'auxiliary_sessions', 'sessions_total', 'prompts', 'input_tokens', 'output_tokens', 'cost_usd', 'cost_estimated_usd'];
  const rows = [];
  for (const d of s.daily)    rows.push(['daily',   d.date,    d.interactive_sessions || 0, d.auxiliary_sessions || 0, d.sessions, d.prompts, d.input_tokens, d.output_tokens, d.cost_usd.toFixed(2), (d.cost_estimated_usd||0).toFixed(2)]);
  for (const u of s.users)    rows.push(['user',    u.user,    u.interactive_sessions || 0, u.auxiliary_sessions || 0, u.sessions, u.prompts, u.input_tokens, u.output_tokens, u.cost_usd.toFixed(2), (u.cost_estimated_usd||0).toFixed(2)]);
  for (const p of s.projects) rows.push(['project', p.project, p.interactive_sessions || 0, p.auxiliary_sessions || 0, p.sessions, p.prompts, p.input_tokens, p.output_tokens, p.cost_usd.toFixed(2), (p.cost_estimated_usd||0).toFixed(2)]);
  downloadCsv(fnamePrefix(s) + '_all.csv', toCsv(headers, rows));
});

const collapseStorageKey = 'token-dashboard.collapsed';
function loadCollapsed() {
  try { return JSON.parse(localStorage.getItem(collapseStorageKey) || '{}'); }
  catch { return {}; }
}
function saveCollapsed(state) {
  try { localStorage.setItem(collapseStorageKey, JSON.stringify(state)); } catch {}
}
const collapsedState = loadCollapsed();
document.querySelectorAll('.section[id]').forEach(sec => {
  if (collapsedState[sec.id]) sec.classList.add('collapsed');
  const h2 = sec.querySelector('h2');
  if (!h2) return;
  h2.addEventListener('click', () => {
    sec.classList.toggle('collapsed');
    collapsedState[sec.id] = sec.classList.contains('collapsed');
    saveCollapsed(collapsedState);
  });
});

render('7d', '');
renderAiAccuracy();

// Click-to-sort for every table. Values are parsed from the rendered cells so
// formatted numbers ($, %, commas, 1.2k / 3.4M suffixes) sort numerically;
// anything else (dates, names) falls back to lexical. A MutationObserver
// re-applies the active sort after a filter re-render so the order sticks.
function makeSortable(table) {
  const head = table.tHead;
  const tbody = table.tBodies[0];
  if (!head || !tbody) return;
  let sortCol = -1, sortDir = 1;

  const NUM_RE = /^[+-]?\\d*\\.?\\d+[kKmM]?$/;
  const BLANK = new Set(['', '-', '—', 'n/a']);
  function parseCell(td) {
    const text = (td.textContent || '').trim();
    const clean = text.replace(/[$,%\\s]/g, '');
    if (NUM_RE.test(clean)) {
      let mult = 1, body = clean;
      const suf = body.slice(-1);
      if (suf === 'k' || suf === 'K') { mult = 1e3; body = body.slice(0, -1); }
      else if (suf === 'm' || suf === 'M') { mult = 1e6; body = body.slice(0, -1); }
      return { num: parseFloat(body) * mult, blank: false, str: text.toLowerCase() };
    }
    return { num: NaN, blank: BLANK.has(text.toLowerCase()), str: text.toLowerCase() };
  }

  // Observe the tbody so the active sort re-applies after a filter re-render.
  // Stays disconnected until the first sort, and is suspended while WE reorder
  // rows — otherwise our own appendChild moves re-trigger the callback in an
  // infinite loop (the records arrive as a later microtask, so a synchronous
  // flag can't gate them).
  const obs = new MutationObserver(() => applySort());

  function applySort() {
    if (sortCol < 0) return;
    const all = Array.from(tbody.rows);
    const totals = all.filter(r => r.classList.contains('total-row'));
    const data = all.filter(r =>
      !r.classList.contains('total-row') &&
      !r.querySelector('.empty-msg') &&
      r.cells.length > sortCol);
    if (data.length < 2) return;
    const parsed = data.map(r => parseCell(r.cells[sortCol]));
    const numeric = parsed.every(p => !isNaN(p.num) || p.blank) && parsed.some(p => !isNaN(p.num));
    const order = data.map((r, i) => i);
    order.sort((ia, ib) => {
      const a = parsed[ia], b = parsed[ib];
      let cmp;
      if (numeric) {
        const na = isNaN(a.num) ? -Infinity : a.num;
        const nb = isNaN(b.num) ? -Infinity : b.num;
        cmp = na - nb;
      } else {
        cmp = a.str < b.str ? -1 : a.str > b.str ? 1 : 0;
      }
      return cmp !== 0 ? cmp * sortDir : ia - ib; // stable on ties
    });
    obs.disconnect();
    order.forEach(i => tbody.appendChild(data[i]));
    totals.forEach(r => tbody.appendChild(r));
    obs.observe(tbody, { childList: true });
  }

  head.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th || !head.contains(th)) return;
    const cells = Array.from(th.parentElement.cells);
    const i = cells.indexOf(th);
    if (i < 0) return;
    if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
    Array.from(head.querySelectorAll('th')).forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
    applySort();
  });
}
document.querySelectorAll('.section table').forEach(makeSortable);
</script>
</body>
</html>
`;
}

function tryOpen(file) {
  // Best-effort: same as bash `open ... || xdg-open ... || echo manually`.
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    const child = spawn(cmd, [file], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best-effort
  }
}

function fmtInt(n) {
  // en-US grouping mirrors Python's f'{n:,}' formatting.
  return Math.trunc(n).toLocaleString('en-US');
}

async function main(argv) {
  const jsonOnly = argv.includes('--json-only');

  // Auto-load .env so ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN (and any other vars)
  // are available without requiring the caller to source it first.
  const envLoaded = loadDotEnv(ROOT_DIR);
  if (envLoaded > 0) console.log(`Loaded ${envLoaded} keys from .env`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (listEventFiles(ROOT_DIR).length === 0) {
    console.log(`No session events found under ${path.join(ROOT_DIR, '.ai-memory')}`);
    process.exit(1);
  }

  console.log('Generating token consumption data...');

  let events;
  try {
    events = readEvents(ROOT_DIR);
  } catch (err) {
    console.log('Failed to generate data.');
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }

  const { data, estimatedCount, reconciledEventCount, sessionsReconciled, users } = buildData(events);

  let jiraBaseUrl = (process.env.JIRA_BASE_URL || '').trim();
  jiraBaseUrl = jiraBaseUrl.replace(/\/+$/, '').replace(/'/g, '');

  const spResult = readSpFromCache();
  data.story_points = spResult.byTicket;
  const aiResult = readAiFromCache();
  data.ai_estimates = {
    byTicket: aiResult.byTicket,
    available: aiResult.available,
    minSample: AI_ACCURACY_MIN_SAMPLE,
  };
  data.adoption = {
    min_prompts_per_day: ADOPTION_MIN_PROMPTS_PER_DAY,
    min_active_days_per_week: ADOPTION_MIN_ACTIVE_DAYS_PER_WEEK,
    min_tokens_per_month: ADOPTION_MIN_TOKENS_PER_MONTH,
    shrink_prior_m: ADOPTION_SHRINK_PRIOR_M,
    jira_available: spResult.available,
    jira_reason: spResult.reason,
  };
  // Delivered universe (AI-coverage view). Opportunistically refresh the YTD
  // window when Jira creds are present so the "untracked tickets" list stays
  // current; on any failure or missing creds we fall back to the committed
  // cache so teammates without creds still render the section. Non-fatal.
  try {
    const siteUrl = jiraBaseUrl;
    const now = new Date();
    const win = { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
    const r = await fetchDeliveredTickets(ROOT_DIR, siteUrl, win);
    if (r.reason === 'ok') console.log(`  Delivered tickets refreshed from Jira: ${r.fetched} (${win.from}→${win.to})`);
    else if (r.reason === 'cache') console.log('  Delivered tickets served from cache (fresh)');
    else console.log(`  Delivered tickets: using committed cache (${r.reason})`);
  } catch (e) {
    console.log(`  Delivered-tickets refresh skipped (${e.message})`);
  }
  const deliveredResult = readDeliveredFromCache();
  data.delivered_tickets = {
    byTicket: deliveredResult.byTicket,
    available: deliveredResult.available,
    window: deliveredResult.window || null,
    generated_at: deliveredResult.generated_at || null,
  };
  data.team_config = readTeamConfig();

  data.ai_landed = readAiLandedFromDeliverySnapshot(ROOT_DIR);
  if (data.ai_landed.available) {
    const l = data.ai_landed.latest;
    console.log(`  AI-landed (${l.window?.start}–${l.window?.end}): ${l.ai_landed_lines}/${l.landed_lines} lines (${l.ai_landed_pct}%), $${l.cost_per_kloc}/1k lines`);
  } else {
    console.log(`  AI-landed metric unavailable (${data.ai_landed.reason})`);
  }
  const ticketCount = Object.keys(spResult.byTicket).length;
  if (spResult.available) {
    const withSp = Object.values(spResult.byTicket).filter(e => e && !e.error && e.sp > 0).length;
    console.log(`  Story points loaded from cache: ${withSp}/${ticketCount} tickets with non-zero SP`);
  } else {
    console.log(`  Story-point cache unavailable (${spResult.reason}) — run \`npm run jira:refresh\``);
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

  console.log(`  Sessions: ${data.total.sessions}`);
  console.log(`  Input tokens: ${fmtInt(data.total.input_tokens)}`);
  console.log(`  Output tokens: ${fmtInt(data.total.output_tokens)}`);
  console.log(`  Total cost: $${data.total.cost_usd.toFixed(2)}  (estimated events: ${estimatedCount}, default model: ${DEFAULT_FAMILY})`);
  if (data.total.cost_billed_usd != null && data.total.cost_billed_usd !== data.total.cost_usd) {
    const src = TIERS_CONFIG ? '.ai-memory/calibration-tiers.json' : `BILLING_CALIBRATION=${BILLING_CALIBRATION}`;
    console.log(`  Billed (est.): $${data.total.cost_billed_usd.toFixed(2)}  (per-user calibration from ${src})`);
  }
  console.log(`  Users: ${users.length}`);
  if (Array.isArray(data.by_model) && data.by_model.length > 0) {
    // Percentage is share-of-model-spend (denominator = sum of by_model), which
    // is internally consistent; it intentionally differs from the windowed
    // headline total above, exactly as the per-session cost column does.
    const modelTotal = data.by_model.reduce((acc, m) => acc + m.cost_usd, 0);
    console.log('  By model (session-cost basis):');
    for (const m of data.by_model) {
      const pct = modelTotal > 0 ? (m.cost_usd / modelTotal * 100) : 0;
      console.log(`    ${m.model.padEnd(12)} $${m.cost_usd.toFixed(2).padStart(9)}  ${pct.toFixed(1).padStart(5)}%  (${m.sessions} sess)`);
    }
  }
  console.log(`  Projects: ${data.by_project.length}`);
  console.log(`  Days: ${data.daily.length}`);
  console.log(`  Reconciled attribution: ${reconciledEventCount} events across ${sessionsReconciled.size} sessions (rendered with "rec" badge)`);

  if (jsonOnly) {
    console.log(`Data written to: ${DATA_FILE}`);
    return 0;
  }

  console.log('Generating HTML dashboard...');

  const html = renderHtml(data, jiraBaseUrl);
  fs.writeFileSync(HTML_FILE, html);

  console.log(`Dashboard generated: ${HTML_FILE}`);
  console.log('Opening...');
  tryOpen(HTML_FILE);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code || 0),
    err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); }
  );
}

module.exports = {
  // Exposed for tests (AC-10, AC-12, AC-13 verification).
  readEvents,
  backfillEstimatedCost,
  applyReconciledAttribution,
  groupBySession,
  aggregate,
  buildData,
  renderHtml,
  LEG_RESET_THRESHOLD,
  LEG_RESET_FIELDS,
  DELTA_FIELDS,
  PROMPT_FIELDS,
};
