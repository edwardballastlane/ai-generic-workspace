#!/usr/bin/env ts-node
/**
 * Rule Effectiveness Stats (`npm run rules:stats`).
 *
 * Aggregates signals from three sources:
 *   - scripts/self-improvement/effectiveness.json  — per-rule fire counts
 *   - .claude/logs/value-events.jsonl              — per-invocation events
 *   - scripts/self-improvement/rules-shared.json + rules.json  — rule catalog
 *
 * Renders a plain-text summary answering:
 *   - Are rules firing at all? Which ones carry the load?
 *   - Are semantic cache hits worth it?
 *   - Which rules have gone stale (never-fired / last-fired very old)?
 *
 * Flags:
 *   --json   machine-readable JSON output
 *   --limit N   top/bottom list size (default 10)
 *   --since YYYY-MM-DD   restrict value-events analysis to this date onward
 */

import * as fs from 'fs';
import * as path from 'path';
import { findWorkspaceRoot } from '../hooks/_lib/workspace-root';

type Rule = {
  id: string;
  text: string;
  status?: string;
  categories?: string[];
  projects?: string[];
};

type Effectiveness = Record<string, {
  fires: number;
  lastFired: string;
  sessions?: string[];
  projects?: string[];
}>;

type ValueEvent = {
  timestamp: string;
  sessionId: string;
  type: string;
  count: number;
  details?: {
    categories?: string[];
    ruleIds?: string[];
    sources?: string[];
    matchSources?: string[];
    project?: string;
  };
};

const WORKSPACE_ROOT = findWorkspaceRoot();
const RULES_DIR = path.join(WORKSPACE_ROOT, 'scripts', 'self-improvement');
const EFFECTIVENESS_PATH = path.join(RULES_DIR, 'effectiveness.json');
const VALUE_EVENTS_PATH = path.join(WORKSPACE_ROOT, '.claude', 'logs', 'value-events.jsonl');

function loadJSON<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; }
  catch { return fallback; }
}

function loadRules(): Map<string, Rule> {
  const shared = loadJSON<Rule[]>(path.join(RULES_DIR, 'rules-shared.json'), []);
  const personal = loadJSON<Rule[]>(path.join(RULES_DIR, 'rules.json'), []);
  const byId = new Map<string, Rule>();
  for (const r of shared) byId.set(r.id, r);
  for (const r of personal) if (!byId.has(r.id)) byId.set(r.id, r);
  return byId;
}

function loadEvents(sinceIso: string | null): ValueEvent[] {
  const events: ValueEvent[] = [];
  let raw: string;
  try { raw = fs.readFileSync(VALUE_EVENTS_PATH, 'utf8'); }
  catch { return events; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ValueEvent;
      if (sinceIso && e.timestamp < sinceIso) continue;
      events.push(e);
    } catch { /* skip malformed */ }
  }
  return events;
}

function daysSince(iso: string): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + '…' : s.padEnd(n, ' ');
}

function color(code: string, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const BOLD = '1';
const DIM = '2';
const GREEN = '32';
const YELLOW = '33';
const RED = '31';
const CYAN = '36';

// ── Analysis ──────────────────────────────────────────────────────────
type Summary = {
  totalRules: number;
  activeRules: number;
  rulesWithFires: number;
  totalFires: number;
  byCategory: Array<{ category: string; fires: number }>;
  top: Array<{ id: string; fires: number; lastFired: string; daysAgo: number | null; text: string; categories: string[] }>;
  neverFired: Array<{ id: string; text: string; categories: string[] }>;
  stale: Array<{ id: string; fires: number; lastFired: string; daysAgo: number; text: string }>;
  events: {
    total: number;
    withMatchSource: number;
    lexical: number;
    relaxed: number;
    semantic: number;
    avgPerInvocation: number;
    byProject: Array<{ project: string; count: number }>;
  };
};

function summarize(rules: Map<string, Rule>, effectiveness: Effectiveness, events: ValueEvent[], limit: number): Summary {
  const activeRules = Array.from(rules.values()).filter(r => r.status === 'active');
  const allActiveIds = new Set(activeRules.map(r => r.id));

  let totalFires = 0;
  const rulesWithFires: string[] = [];
  for (const [id, e] of Object.entries(effectiveness)) {
    if (!allActiveIds.has(id)) continue;
    totalFires += e.fires || 0;
    if ((e.fires || 0) > 0) rulesWithFires.push(id);
  }

  const byCategoryMap = new Map<string, number>();
  for (const r of activeRules) {
    const fires = effectiveness[r.id]?.fires || 0;
    if (fires === 0) continue;
    for (const cat of r.categories || []) {
      byCategoryMap.set(cat, (byCategoryMap.get(cat) || 0) + fires);
    }
  }
  const byCategory = Array.from(byCategoryMap.entries())
    .map(([category, fires]) => ({ category, fires }))
    .sort((a, b) => b.fires - a.fires);

  const top = rulesWithFires
    .map(id => {
      const e = effectiveness[id];
      const r = rules.get(id)!;
      return {
        id,
        fires: e.fires,
        lastFired: e.lastFired || '',
        daysAgo: daysSince(e.lastFired),
        text: r.text,
        categories: r.categories || [],
      };
    })
    .sort((a, b) => b.fires - a.fires)
    .slice(0, limit);

  const neverFired = activeRules
    .filter(r => !effectiveness[r.id] || effectiveness[r.id].fires === 0)
    .map(r => ({ id: r.id, text: r.text, categories: r.categories || [] }))
    .slice(0, limit);

  const STALE_DAYS = 60;
  const stale = rulesWithFires
    .map(id => {
      const e = effectiveness[id];
      const r = rules.get(id)!;
      const d = daysSince(e.lastFired);
      return d !== null && d >= STALE_DAYS
        ? { id, fires: e.fires, lastFired: e.lastFired, daysAgo: d, text: r.text }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.daysAgo - a.daysAgo)
    .slice(0, limit);

  // Event-level stats
  const ruleInjection = events.filter(e => e.type === 'rule_injection');
  let lexical = 0;
  let relaxed = 0; // placeholder — relaxed tagging lives on the prefix, not in matchSources yet
  let semantic = 0;
  let withMatchSource = 0;
  const byProj = new Map<string, number>();
  let totalInjected = 0;
  for (const e of ruleInjection) {
    totalInjected += e.count || 0;
    const p = e.details?.project || 'unknown';
    byProj.set(p, (byProj.get(p) || 0) + 1);
    const ms = e.details?.matchSources;
    if (ms && ms.length > 0) {
      withMatchSource++;
      for (const src of ms) {
        if (src === 'lexical') lexical++;
        else if (src === 'semantic') semantic++;
      }
    }
  }
  const byProject = Array.from(byProj.entries())
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalRules: rules.size,
    activeRules: activeRules.length,
    rulesWithFires: rulesWithFires.length,
    totalFires,
    byCategory,
    top,
    neverFired,
    stale,
    events: {
      total: ruleInjection.length,
      withMatchSource,
      lexical,
      relaxed,
      semantic,
      avgPerInvocation: ruleInjection.length > 0 ? totalInjected / ruleInjection.length : 0,
      byProject,
    },
  };
}

// ── Renderers ─────────────────────────────────────────────────────────
function renderText(s: Summary, limit: number): string {
  const lines: string[] = [];
  const hr = color(DIM, '─'.repeat(72));

  lines.push(color(BOLD, 'Rule Effectiveness'));
  lines.push(hr);

  // Corpus
  const firingPct = s.activeRules > 0 ? ((s.rulesWithFires / s.activeRules) * 100).toFixed(0) : '0';
  lines.push(`Corpus:       ${s.activeRules} active / ${s.totalRules} total`);
  lines.push(`Firing:       ${color(GREEN, String(s.rulesWithFires))} rules have fired (${firingPct}% of active)`);
  lines.push(`Total fires:  ${s.totalFires}`);

  // Events
  if (s.events.total > 0) {
    const semRate = s.events.lexical + s.events.semantic > 0
      ? ((s.events.semantic / (s.events.lexical + s.events.semantic)) * 100).toFixed(0)
      : '0';
    lines.push('');
    lines.push(color(BOLD, 'Injection events'));
    lines.push(`Invocations:  ${s.events.total}  (avg ${s.events.avgPerInvocation.toFixed(1)} rules each)`);
    lines.push(`Match mix:    ${color(CYAN, String(s.events.lexical))} lexical · ${color(CYAN, String(s.events.semantic))} semantic  ${s.events.withMatchSource > 0 ? `(${semRate}% semantic)` : color(DIM, '(only newer events tag match source)')}`);
    if (s.events.byProject.length > 0) {
      const top = s.events.byProject.slice(0, 3).map(p => `${p.project}=${p.count}`).join('  ');
      lines.push(`Top projects: ${top}`);
    }
  }

  // Top rules
  lines.push('');
  lines.push(color(BOLD, `Top ${Math.min(limit, s.top.length)} rules by fires`));
  lines.push(hr);
  if (s.top.length === 0) {
    lines.push(color(DIM, '  (no rules have fired yet)'));
  } else {
    for (const r of s.top) {
      const age = r.daysAgo !== null ? `${r.daysAgo}d` : '—';
      const cat = r.categories.length > 0 ? `[${r.categories[0]}]` : '';
      lines.push(`  ${pad(r.id, 10)} ${String(r.fires).padStart(4)} fires  ${pad(age, 5)}  ${pad(cat, 14)} ${r.text.slice(0, 72)}`);
    }
  }

  // By category
  if (s.byCategory.length > 0) {
    lines.push('');
    lines.push(color(BOLD, 'Fires by category'));
    lines.push(hr);
    for (const c of s.byCategory.slice(0, 10)) {
      lines.push(`  ${pad(c.category, 18)} ${String(c.fires).padStart(5)}`);
    }
  }

  // Stale
  if (s.stale.length > 0) {
    lines.push('');
    lines.push(color(BOLD, `Stale (fires > 0 but not fired in 60+ days)`));
    lines.push(hr);
    for (const r of s.stale) {
      lines.push(`  ${pad(r.id, 10)} ${String(r.fires).padStart(4)} fires  ${color(YELLOW, `${r.daysAgo}d`)}  ${r.text.slice(0, 72)}`);
    }
  }

  // Never fired
  if (s.neverFired.length > 0) {
    lines.push('');
    lines.push(color(BOLD, `Never-fired rules (${s.activeRules - s.rulesWithFires} total)`));
    lines.push(hr);
    for (const r of s.neverFired) {
      const cat = r.categories.length > 0 ? `[${r.categories[0]}]` : '';
      lines.push(`  ${pad(r.id, 10)} ${color(RED, 'never')}  ${pad(cat, 14)} ${r.text.slice(0, 72)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { json: boolean; limit: number; since: string | null } {
  let json = false;
  let limit = 10;
  let since: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--limit') limit = parseInt(argv[++i] || '10', 10) || 10;
    else if (a === '--since') since = argv[++i] || null;
  }
  return { json, limit, since };
}

function main(): void {
  const { json, limit, since } = parseArgs(process.argv.slice(2));
  const sinceIso = since ? new Date(since).toISOString() : null;

  const rules = loadRules();
  const effectiveness = loadJSON<Effectiveness>(EFFECTIVENESS_PATH, {});
  const events = loadEvents(sinceIso);

  const summary = summarize(rules, effectiveness, events, limit);

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(summary, limit));
  }
}

main();
