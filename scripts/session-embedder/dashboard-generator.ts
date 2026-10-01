#!/usr/bin/env ts-node
/**
 * Unified Dashboard Data Generator
 *
 * Aggregates data from multiple sources (Qdrant, rules.json, JSONL logs, session files)
 * into a single JSON file for dashboard consumption.
 *
 * Sources:
 *   - Qdrant collections: session-embeddings, reflections, rules
 *   - rules.json: self-improvement rule lifecycle data
 *   - value-events.jsonl: rule injection and skill suggestion events
 *   - search-log.jsonl: session search activity
 *   - Claude Code session JSONL transcripts (~/.claude/projects/<encoded-cwd>/*.jsonl): topic/entity extraction
 *
 * Output: .claude/visualizations/dashboard-data.json
 *
 * Usage:
 *   npx ts-node scripts/session-embedder/dashboard-generator.ts
 *   // or import { generateDashboard } from './dashboard-generator';
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { QDRANT_URL, qdrantHeaders } from '../shared/qdrant';
import {
  readSessionMetrics, readReflectionMetrics, aggregateSessions, aggregateReflections,
} from './self-metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (
      fs.existsSync(path.join(current, 'CLAUDE.md')) ||
      fs.existsSync(path.join(current, '.claude'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Return ISO week identifier for a date string, e.g. "2026-W06".
 */
function getISOWeek(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'unknown';
    // ISO week calculation
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = tmp.getUTCDay() || 7; // Sunday = 7
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Return YYYY-MM-DD from a timestamp string.
 */
function getDay(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'unknown';
    return d.toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

/**
 * Read a JSONL file and return an array of parsed objects.
 * Returns empty array if the file does not exist or cannot be parsed.
 */
function readJsonlFile(filePath: string): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    const results: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * GET a Qdrant collection's points_count, returning 0 on any error.
 */
async function getCollectionCount(collection: string): Promise<number> {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/${collection}`, { headers: qdrantHeaders() });
    if (!response.ok) return 0;
    const data = (await response.json()) as { result?: { points_count?: number } };
    return data.result?.points_count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Rule interfaces
// ---------------------------------------------------------------------------

interface RuleActor { name: string; email: string }
interface RuleHistoryEvent { at: string; event: string; actor: RuleActor; detail?: string }
interface Rule {
  id: string;
  text: string;
  source: string;
  status: string;
  reinforcementCount: number;
  createdAt: string;
  lastReinforced: string;
  sourceSessionIds: string[];
  categories?: string[];
  _scope?: 'team' | 'personal';
  author?: RuleActor;
  promotedBy?: RuleActor;
  promotedAt?: string;
  history?: RuleHistoryEvent[];
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildRulesSection(rules: Rule[]): Record<string, unknown> {
  // lifecycle counts
  const lifecycle: Record<string, number> = {};
  for (const r of rules) {
    lifecycle[r.status] = (lifecycle[r.status] || 0) + 1;
  }

  // bySource
  const bySource: Record<string, number> = {};
  for (const r of rules) {
    bySource[r.source] = (bySource[r.source] || 0) + 1;
  }

  // byCategory — flatten categories from active rules
  const byCategory: Record<string, number> = {};
  for (const r of rules) {
    if (r.status !== 'active' || !r.categories) continue;
    for (const cat of r.categories) {
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
  }

  // topReinforced — top 15 active by reinforcementCount (for display)
  const topReinforced = rules
    .filter(r => r.status === 'active')
    .sort((a, b) => b.reinforcementCount - a.reinforcementCount)
    .slice(0, 15)
    .map(r => ({ id: r.id, text: r.text, count: r.reinforcementCount }));

  // Funnel counts — full dataset, not just top 15 (used by Rule Lifecycle chart)
  const reinforcedCount = rules.filter(r => r.status === 'active' && r.reinforcementCount >= 5).length;
  const provenCount = rules.filter(r => r.status === 'active' && r.reinforcementCount >= 10).length;

  // neverUsed — active rules with reinforcementCount === 0
  const neverUsed = rules
    .filter(r => r.status === 'active' && r.reinforcementCount === 0)
    .map(r => ({ id: r.id, text: r.text, createdAt: r.createdAt }));

  // createdOverTime — group by ISO week
  const weekCounts: Record<string, number> = {};
  for (const r of rules) {
    const week = getISOWeek(r.createdAt);
    weekCounts[week] = (weekCounts[week] || 0) + 1;
  }
  const createdOverTime = Object.entries(weekCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, count]) => ({ week, count }));

  // reinforcementDistribution — bucket active rules
  const buckets: Record<string, number> = {
    '0': 0,
    '1-5': 0,
    '6-10': 0,
    '11-20': 0,
    '21-50': 0,
    '50+': 0,
  };
  for (const r of rules) {
    if (r.status !== 'active') continue;
    const c = r.reinforcementCount;
    if (c === 0) buckets['0']++;
    else if (c <= 5) buckets['1-5']++;
    else if (c <= 10) buckets['6-10']++;
    else if (c <= 20) buckets['11-20']++;
    else if (c <= 50) buckets['21-50']++;
    else buckets['50+']++;
  }
  const reinforcementDistribution = Object.entries(buckets).map(([bucket, count]) => ({
    bucket,
    count,
  }));

  // byScope — team vs personal breakdown
  const byScope: Record<string, { total: number; active: number; categories: Record<string, number> }> = {
    team: { total: 0, active: 0, categories: {} },
    personal: { total: 0, active: 0, categories: {} },
  };
  for (const r of rules) {
    const scope = r._scope || 'personal';
    byScope[scope].total++;
    if (r.status === 'active') {
      byScope[scope].active++;
      for (const cat of r.categories || []) {
        byScope[scope].categories[cat] = (byScope[scope].categories[cat] || 0) + 1;
      }
    }
  }

  // teamRules / personalRules — full lists for team tab
  const buildScopedList = (scope: 'team' | 'personal') =>
    rules
      .filter(r => r._scope === scope && r.status === 'active')
      .sort((a, b) => b.reinforcementCount - a.reinforcementCount)
      .map(r => ({
        id: r.id,
        text: r.text,
        count: r.reinforcementCount,
        categories: r.categories || [],
        createdAt: r.createdAt,
        author: r.author || null,
        promotedBy: r.promotedBy || null,
        promotedAt: r.promotedAt || null,
        lastEvent: lastHistoryEvent(r),
      }));
  const teamRules = buildScopedList('team');
  const personalRules = buildScopedList('personal');

  // byAuthor — count active rules per original author. Includes promoter
  // counts separately so the dashboard can show both "originated N" and
  // "promoted M" per teammate.
  const byAuthor: Record<string, { authored: number; promoted: number; reinforcements: number }> = {};
  for (const r of rules) {
    if (r.status !== 'active') continue;
    const authorKey = r.author?.name || '(unknown)';
    if (!byAuthor[authorKey]) byAuthor[authorKey] = { authored: 0, promoted: 0, reinforcements: 0 };
    byAuthor[authorKey].authored++;
    byAuthor[authorKey].reinforcements += r.reinforcementCount;
    const promoterKey = r.promotedBy?.name;
    if (promoterKey) {
      if (!byAuthor[promoterKey]) byAuthor[promoterKey] = { authored: 0, promoted: 0, reinforcements: 0 };
      byAuthor[promoterKey].promoted++;
    }
  }

  // recentAudit — last 30 history events across all rules, newest first.
  // Lets the dashboard show "what happened to which rule recently".
  const auditEntries: Array<{ at: string; event: string; actor: string; ruleId: string; ruleText: string; detail: string }> = [];
  for (const r of rules) {
    for (const h of r.history || []) {
      auditEntries.push({
        at: h.at,
        event: h.event,
        actor: h.actor?.name || 'unknown',
        ruleId: r.id,
        ruleText: r.text,
        detail: h.detail || '',
      });
    }
  }
  auditEntries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const recentAudit = auditEntries.slice(0, 30);

  return {
    lifecycle: {
      ...lifecycle,
      reinforcedCount,
      provenCount,
    },
    bySource,
    byCategory,
    byAuthor,
    byScope,
    teamRules,
    personalRules,
    topReinforced,
    neverUsed,
    createdOverTime,
    reinforcementDistribution,
    recentAudit,
  };
}

function lastHistoryEvent(r: Rule): { at: string; event: string; actor: string; detail: string } | null {
  const h = (r.history || [])[(r.history || []).length - 1];
  return h ? { at: h.at, event: h.event, actor: h.actor?.name || 'unknown', detail: h.detail || '' } : null;
}

const LIFECYCLE_EVENTS = new Set(['created', 'activated', 'retired', 'promoted-to-team']);

function buildValueEventsSection(
  events: Record<string, unknown>[],
  rulesLookup: Map<string, string>,
  rules: Rule[] = [],
): Record<string, unknown> {
  const total = events.length;

  // byType
  const byType: Record<string, number> = {};
  for (const e of events) {
    const t = (e.type as string) || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }

  // overTime — group by day, split by type. Two synthetic types are folded in
  // from the rule audit trail so the chart stops showing two flat-zero series
  // (skill_suggestion has no producer; session_search has 3 producers that
  // almost never fire interactively):
  //   reinforcement = count of 'reinforced' history events per day
  //   lifecycle     = count of 'created' + 'activated' + 'retired' +
  //                   'promoted-to-team' history events per day (the events
  //                   that change a rule's standing, not its usage)
  const dayTypeMap: Record<string, Record<string, number>> = {};
  for (const e of events) {
    const day = getDay(e.timestamp as string);
    const t = (e.type as string) || 'unknown';
    if (!dayTypeMap[day]) dayTypeMap[day] = {};
    dayTypeMap[day][t] = (dayTypeMap[day][t] || 0) + 1;
  }
  for (const r of rules) {
    for (const h of r.history || []) {
      const day = getDay(h.at);
      if (!dayTypeMap[day]) dayTypeMap[day] = {};
      if (h.event === 'reinforced') {
        dayTypeMap[day].reinforcement = (dayTypeMap[day].reinforcement || 0) + 1;
      } else if (LIFECYCLE_EVENTS.has(h.event)) {
        dayTypeMap[day].lifecycle = (dayTypeMap[day].lifecycle || 0) + 1;
      }
    }
  }
  const overTime = Object.entries(dayTypeMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => ({ day, ...counts }));

  // topInjectedRules — from rule_injection events, count ruleId occurrences
  const ruleIdCounts: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'rule_injection') continue;
    const details = e.details as Record<string, unknown> | undefined;
    const ruleIds = details?.ruleIds as string[] | undefined;
    if (!ruleIds) continue;
    for (const rid of ruleIds) {
      ruleIdCounts[rid] = (ruleIdCounts[rid] || 0) + 1;
    }
  }
  const topInjectedRules = Object.entries(ruleIdCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([ruleId, injectionCount]) => ({
      ruleId,
      injectionCount,
      text: rulesLookup.get(ruleId) || null,
    }));

  // topCategories — from rule_injection events, count category occurrences
  const categoryCounts: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'rule_injection') continue;
    const details = e.details as Record<string, unknown> | undefined;
    const categories = details?.categories as string[] | undefined;
    if (!categories) continue;
    for (const cat of categories) {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
  }
  const topCategories = Object.entries(categoryCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([category, count]) => ({ category, count }));

  return {
    total,
    byType,
    overTime,
    topInjectedRules,
    topCategories,
  };
}

// Builds the "Rule-Match Analytics" card (template card-title repurposed from
// "Search Analytics"). Source changed from search-log.jsonl — written only by
// the rarely-invoked manual search CLIs — to rule_injection entries in
// value-events.jsonl, which fire on every prompt via inject-rules-impl. Each
// injection now carries topScore + avgScore (commit plumbing them through
// shipped alongside this change).
function buildSearchSection(valueEvents: Record<string, unknown>[]): Record<string, unknown> {
  const injectionEvents = valueEvents.filter(e => e.type === 'rule_injection');
  const totalQueries = injectionEvents.length;

  let resultSum = 0;
  let topScoreSum = 0;
  let topScoreCount = 0;
  for (const e of injectionEvents) {
    resultSum += (e.count as number) || 0;
    const details = (e.details as Record<string, unknown>) || {};
    const ts = (details.topScore as number) || 0;
    if (ts > 0) {
      topScoreSum += ts;
      topScoreCount++;
    }
  }
  const avgResultCount = totalQueries > 0 ? Math.round((resultSum / totalQueries) * 100) / 100 : 0;
  const avgTopScore = topScoreCount > 0 ? Math.round((topScoreSum / topScoreCount) * 10000) / 10000 : 0;

  const dayCounts: Record<string, number> = {};
  for (const e of injectionEvents) {
    const day = getDay(e.timestamp as string);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }
  const queryOverTime = Object.entries(dayCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }));

  // topQueries — repurposed to top-injected-rule-ids since inject-rules
  // doesn't have a free-text query. Each rule injection contributes its
  // ruleIds[] to the tally.
  const ruleIdCounts: Record<string, number> = {};
  for (const e of injectionEvents) {
    const details = (e.details as Record<string, unknown>) || {};
    const ids = (details.ruleIds as string[]) || [];
    for (const id of ids) ruleIdCounts[id] = (ruleIdCounts[id] || 0) + 1;
  }
  const topQueries = Object.entries(ruleIdCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([query, count]) => ({ query, count }));

  return {
    totalQueries,
    avgResultCount,
    avgTopScore,
    queryOverTime,
    topQueries,
  };
}

// ---------------------------------------------------------------------------
// Qdrant scrolling helpers
// ---------------------------------------------------------------------------

interface ScrollPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * Scroll through a Qdrant collection, requesting specific payload fields.
 * Returns up to `maxPoints` points. On any error, returns an empty array.
 */
async function scrollCollection(
  collection: string,
  includeFields: string[],
  maxPoints: number = 1000,
): Promise<ScrollPoint[]> {
  const results: ScrollPoint[] = [];
  let offset: string | number | null = null;
  const PAGE_SIZE = 250;

  try {
    while (results.length < maxPoints) {
      const body: Record<string, unknown> = {
        limit: Math.min(PAGE_SIZE, maxPoints - results.length),
        with_payload: { include: includeFields },
        with_vector: false,
      };
      if (offset !== null) {
        body.offset = offset;
      }

      const response = await fetch(
        `${QDRANT_URL}/collections/${collection}/points/scroll`,
        {
          method: 'POST',
          headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) break;

      const data = (await response.json()) as {
        result?: { points?: ScrollPoint[]; next_page_offset?: string | number | null };
      };
      const points = data.result?.points || [];
      results.push(...points);

      offset = data.result?.next_page_offset ?? null;
      if (offset === null || points.length === 0) break;
    }
  } catch {
    // Qdrant unavailable — return whatever we collected so far
  }

  return results;
}

async function buildSessionsSection(workspaceRoot: string): Promise<Record<string, unknown>> {
  // Prefer the git-tracked, file-backed metrics (no Qdrant needed — works in CI).
  // Fall back to a direct Qdrant scroll only when the file hasn't been backfilled.
  const fileRows = readSessionMetrics(workspaceRoot);
  if (fileRows.length > 0) {
    const agg = aggregateSessions(fileRows) as { totalEmbedded: number; totalChunks: number };
    console.log(chalk.gray(`   ${agg.totalEmbedded} sessions, ${agg.totalChunks} chunks (file-backed)`));
    return agg as Record<string, unknown>;
  }

  console.log(chalk.gray('   Querying session-embeddings collection...'));

  // Run independent Qdrant queries in parallel
  const [totalChunks, sessionPoints, qualityPoints, datePoints] = await Promise.all([
    getCollectionCount('session-embeddings'),
    scrollCollection('session-embeddings', ['session_id']),
    scrollCollection('session-embeddings', ['quality_score'], 1000),
    scrollCollection('session-embeddings', ['date', 'session_id'], 1000),
  ]);

  // Process unique session_ids
  const uniqueSessionIds = new Set<string>();
  for (const p of sessionPoints) {
    const sid = p.payload.session_id as string | undefined;
    if (sid) uniqueSessionIds.add(sid);
  }
  const totalEmbedded = uniqueSessionIds.size;

  // Process quality_score distribution
  const qualityBuckets: Record<string, number> = {
    '1-2': 0,
    '3-4': 0,
    '5-6': 0,
    '7-8': 0,
    '9-10': 0,
  };
  let scoredCount = 0;
  for (const p of qualityPoints) {
    const qs = p.payload.quality_score as number | undefined;
    if (qs === undefined || qs === null) continue;
    scoredCount++;
    if (qs <= 2) qualityBuckets['1-2']++;
    else if (qs <= 4) qualityBuckets['3-4']++;
    else if (qs <= 6) qualityBuckets['5-6']++;
    else if (qs <= 8) qualityBuckets['7-8']++;
    else qualityBuckets['9-10']++;
  }

  // Process date field to build embeddedOverTime
  // Group sessions by week (use one entry per unique session per week)
  const sessionWeeks = new Map<string, Set<string>>();
  for (const p of datePoints) {
    const dateStr = p.payload.date as string | undefined;
    const sid = p.payload.session_id as string | undefined;
    if (!dateStr || !sid) continue;
    const week = getISOWeek(dateStr);
    if (!sessionWeeks.has(week)) sessionWeeks.set(week, new Set());
    sessionWeeks.get(week)!.add(sid);
  }
  const embeddedOverTime = Array.from(sessionWeeks.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, sessions]) => ({ week, sessions: sessions.size }));

  console.log(
    chalk.gray(
      `   Found ${totalEmbedded} sessions, ${totalChunks} chunks, ${scoredCount} scored`,
    ),
  );

  return {
    totalEmbedded,
    totalChunks,
    qualityDistribution: qualityBuckets,
    embeddedOverTime,
  };
}

async function buildReflectionsSection(workspaceRoot: string): Promise<Record<string, unknown>> {
  // Prefer the git-tracked, file-backed reflections (no Qdrant needed).
  const fileRows = readReflectionMetrics(workspaceRoot);
  if (fileRows.length > 0) {
    return aggregateReflections(fileRows) as Record<string, unknown>;
  }

  console.log(chalk.gray('   Querying reflections collection...'));

  const total = await getCollectionCount('reflections');

  let byFailureType: Record<string, number> = {};
  let recentReflections: Array<{
    date: string;
    failureDescription: string;
    rootCause: string;
    preventionRule: string;
    sessionId: string;
  }> = [];

  try {
    const points = await scrollCollection(
      'reflections',
      ['failure_type', 'failure_description', 'root_cause', 'prevention_rule', 'date', 'session_id'],
      1000,
    );
    const counts: Record<string, number> = {};
    for (const p of points) {
      const ft = p.payload.failure_type as string | undefined;
      if (!ft) continue;
      counts[ft] = (counts[ft] || 0) + 1;
    }
    byFailureType = counts;

    // Extract recent reflections sorted by date descending, top 20
    recentReflections = points
      .filter(p => p.payload.date)
      .sort((a, b) => {
        const da = String(a.payload.date || '');
        const db = String(b.payload.date || '');
        return db.localeCompare(da);
      })
      .slice(0, 20)
      .map(p => ({
        date: String(p.payload.date || ''),
        failureDescription: String(p.payload.failure_description || ''),
        rootCause: String(p.payload.root_cause || ''),
        preventionRule: String(p.payload.prevention_rule || ''),
        sessionId: String(p.payload.session_id || ''),
      }));
  } catch {
    // collection may not exist or have no failure_type field
  }

  console.log(chalk.gray(`   Found ${total} reflections, ${recentReflections.length} recent`));

  return {
    total,
    byFailureType,
    recentReflections,
  };
}

async function buildPipelineSection(
  rules: Rule[],
): Promise<Record<string, unknown>> {
  console.log(chalk.gray('   Computing pipeline stats...'));

  const rulesSynced = await getCollectionCount('rules');

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  let recentProposed = 0;
  let recentActivated = 0;
  let latestCreatedAt = '';

  for (const r of rules) {
    const createdTime = new Date(r.createdAt).getTime();
    if (isNaN(createdTime)) continue;

    if (r.createdAt > latestCreatedAt) {
      latestCreatedAt = r.createdAt;
    }

    if (createdTime >= sevenDaysAgo) {
      if (r.status === 'proposed') recentProposed++;
      if (r.status === 'active') recentActivated++;
    }
  }

  // Read recent self-improvement git commits from the last 30 days
  let recentActivity: Array<{ hash: string; message: string; date: string }> = [];
  try {
    const gitOutput = execSync(
      'git log --oneline --after="30 days ago" --grep="chore(self-improve):" --format="%h|%s|%ai"',
      { encoding: 'utf8', timeout: 10000 },
    ).trim();
    if (gitOutput) {
      // Build a lookup of rule texts for expanding truncated commit subjects
      const ruleTexts = rules.map(r => r.text || '').filter(Boolean);

      recentActivity = gitOutput.split('\n').map(line => {
        const [hash, message, date] = line.split('|');
        let fullMessage = message || '';

        // If the commit subject looks truncated (doesn't end with punctuation or a complete word),
        // try to match it against the full rule text from rules.json
        const ruleMatch = fullMessage.match(/^chore\(self-improve\):\s*add rule:\s*(.+)/i);
        if (ruleMatch) {
          const partial = ruleMatch[1].trim();
          const matched = ruleTexts.find(t => t.startsWith(partial) && t.length > partial.length);
          if (matched) {
            fullMessage = 'chore(self-improve): add rule: ' + matched;
          }
        }

        return { hash: hash || '', message: fullMessage, date: date || '' };
      });
    }
  } catch {
    // git log failed — non-critical, return empty array
  }

  console.log(
    chalk.gray(
      `   ${rulesSynced} rules synced, ${recentProposed} proposed / ${recentActivated} activated in last 7d, ${recentActivity.length} recent commits`,
    ),
  );

  return {
    lastRun: latestCreatedAt || new Date().toISOString(),
    rulesSynced,
    recentProposed,
    recentActivated,
    recentActivity,
  };
}

// ---------------------------------------------------------------------------
// Topic extraction types and patterns (from topic-map.ts)
// ---------------------------------------------------------------------------

type EntityType = 'tool' | 'concept' | 'action' | 'pattern' | 'search';

interface ExtractedTerm {
  term: string;
  type: EntityType;
  count: number;
  sessions: Set<string>;
  contexts: string[];
}

interface SearchLogEntry {
  timestamp: string;
  source: string;
  query: string;
  resultsCount: number;
  topScore: number;
  topSessionId: string;
  durationMs: number;
}

// Common programming/tech terms to extract
const TOOL_PATTERNS = [
  // Languages
  /\b(typescript|javascript|python|rust|golang|java|c\+\+|ruby|php|swift|kotlin)\b/gi,
  // Frameworks/Libraries
  /\b(react|vue|angular|svelte|next\.?js|nuxt|express|fastapi|django|flask|spring|rails)\b/gi,
  /\b(node\.?js|deno|bun)\b/gi,
  // Databases
  /\b(postgres(?:ql)?|mysql|mongodb|redis|sqlite|supabase|prisma|drizzle|sequelize)\b/gi,
  // Tools
  /\b(docker|kubernetes|k8s|terraform|ansible|jenkins|github|gitlab|vercel|netlify|aws|gcp|azure)\b/gi,
  /\b(npm|yarn|pnpm|pip|cargo|maven|gradle)\b/gi,
  /\b(webpack|vite|esbuild|rollup|parcel|turbopack)\b/gi,
  /\b(jest|vitest|mocha|pytest|cypress|playwright)\b/gi,
  /\b(eslint|prettier|biome|husky)\b/gi,
  /\b(git|vim|vscode|neovim|emacs)\b/gi,
  // AI/ML
  /\b(ollama|openai|anthropic|claude|gpt-?[34]|llama|langchain|llamaindex)\b/gi,
  /\b(qdrant|pinecone|weaviate|chroma|milvus)\b/gi,
  // Specific libraries
  /\b(lodash|axios|fetch|zod|yup|tanstack|trpc|graphql|rest)\b/gi,
];

const CONCEPT_PATTERNS = [
  // Patterns
  /\b(dependency injection|inversion of control|singleton|factory|observer|strategy|decorator)\b/gi,
  /\b(mvc|mvvm|flux|redux|state management|event sourcing|cqrs)\b/gi,
  /\b(microservices?|monolith|serverless|edge computing|cdn)\b/gi,
  /\b(rest(?:ful)?|graphql|grpc|websocket|sse|polling)\b/gi,
  // Concepts
  /\b(authentication|authorization|oauth|jwt|session|cookie|token)\b/gi,
  /\b(embedding|vector|semantic search|rag|retrieval|chunking)\b/gi,
  /\b(caching|memoization|lazy loading|code splitting|tree shaking)\b/gi,
  /\b(ci\/cd|continuous integration|continuous deployment|devops|gitops)\b/gi,
  /\b(tdd|bdd|unit test|integration test|e2e|testing)\b/gi,
  /\b(refactor(?:ing)?|debugging|profiling|optimization)\b/gi,
  /\b(async|await|promise|callback|event loop|concurrency)\b/gi,
  /\b(type safety|type inference|generics|interfaces?|schemas?)\b/gi,
  /\b(hooks?|components?|props?|state|context|effects?)\b/gi,
  /\b(api|endpoint|route|middleware|controller|service|repository)\b/gi,
  /\b(validation|sanitization|error handling|logging|monitoring)\b/gi,
];

const ACTION_PATTERNS = [
  /\b(npm (?:install|run|build|test|publish))\b/gi,
  /\b(git (?:commit|push|pull|merge|rebase|checkout|branch|clone))\b/gi,
  /\b(docker (?:build|run|compose|push|pull))\b/gi,
  /\b(deploy(?:ed|ing|ment)?|migrat(?:e|ed|ing|ion))\b/gi,
  /\b(creat(?:e|ed|ing)|implement(?:ed|ing)?|fix(?:ed|ing)?|updat(?:e|ed|ing)|refactor(?:ed|ing)?)\b/gi,
];

// Stop words to filter out
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'we', 'they', 'he', 'she',
  'my', 'your', 'our', 'their', 'his', 'her', 'me', 'us', 'them', 'what', 'which',
  'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then', 'once',
  'if', 'else', 'elif', 'while', 'until', 'unless', 'return', 'true', 'false', 'null',
  'undefined', 'const', 'let', 'var', 'function', 'class', 'interface', 'type',
  'import', 'export', 'default', 'from', 'require', 'module', 'new', 'delete',
  'file', 'files', 'code', 'line', 'lines', 'change', 'changes', 'use', 'using', 'used',
  'need', 'needs', 'want', 'wants', 'like', 'make', 'makes', 'get', 'gets', 'set', 'sets',
  'add', 'adds', 'remove', 'removes', 'update', 'updates', 'can', 'way', 'ways',
  'thing', 'things', 'something', 'anything', 'nothing', 'everything',
]);

// ---------------------------------------------------------------------------
// Topic extraction functions (from topic-map.ts)
// ---------------------------------------------------------------------------

/**
 * Extract text content from a Claude Code JSONL session transcript for topic extraction.
 * Each line is one event; we keep `user`/`assistant` text payloads and skip meta entries.
 */
function extractTopicSessionText(sessionPath: string): { text: string; sessionId: string } {
  const sessionId = path.basename(sessionPath).replace(/\.jsonl?$/, '');
  const parts: string[] = [];

  const raw = fs.readFileSync(sessionPath, 'utf8');
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line) continue;
    let entry: {
      type?: string;
      isMeta?: boolean;
      isSidechain?: boolean;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.isMeta || entry.isSidechain) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const content = entry.message?.content;
    if (content == null) continue;

    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const t = (block as { text?: unknown }).text;
          if (typeof t === 'string') text += (text ? '\n' : '') + t;
        }
      }
    }

    if (text.length > 10) parts.push(text);
  }

  return { text: parts.join('\n\n'), sessionId };
}

/**
 * Resolve the directory where Claude Code stores JSONL session transcripts for the
 * given workspace. The directory name is the workspace path with `/` replaced by `-`.
 */
function resolveClaudeSessionsDir(workspaceRoot: string): string {
  const encoded = workspaceRoot.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

/**
 * Extract terms from text using pattern matching
 */
function extractTerms(
  text: string,
  sessionId: string,
  existingTerms: Map<string, ExtractedTerm>,
): void {
  // Extract tools
  for (const pattern of TOOL_PATTERNS) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const term = match[1].toLowerCase();
      addTerm(existingTerms, term, 'tool', sessionId, getContext(text, match.index));
    }
  }

  // Extract concepts
  for (const pattern of CONCEPT_PATTERNS) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const term = match[1].toLowerCase();
      addTerm(existingTerms, term, 'concept', sessionId, getContext(text, match.index));
    }
  }

  // Extract actions
  for (const pattern of ACTION_PATTERNS) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const term = match[1].toLowerCase();
      addTerm(existingTerms, term, 'action', sessionId, getContext(text, match.index));
    }
  }

  // Extract camelCase and PascalCase identifiers (potential components, functions)
  const identifierPattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = identifierPattern.exec(text)) !== null) {
    const term = match[1];
    // Only include if it appears multiple times
    if ((text.match(new RegExp(`\\b${term}\\b`, 'g'))?.length || 0) > 2) {
      addTerm(existingTerms, term, 'pattern', sessionId, getContext(text, match.index));
    }
  }
}

function addTerm(
  terms: Map<string, ExtractedTerm>,
  term: string,
  type: EntityType,
  sessionId: string,
  context: string,
): void {
  const key = term.toLowerCase();

  if (STOP_WORDS.has(key) || key.length < 2) return;

  if (terms.has(key)) {
    const existing = terms.get(key)!;
    existing.count++;
    existing.sessions.add(sessionId);
    if (existing.contexts.length < 3 && context && !existing.contexts.includes(context)) {
      existing.contexts.push(context);
    }
  } else {
    terms.set(key, {
      term,
      type,
      count: 1,
      sessions: new Set([sessionId]),
      contexts: context ? [context] : [],
    });
  }
}

function getContext(text: string, index: number, radius: number = 50): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.substring(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Extract noun phrases using simple heuristics
 */
function extractNounPhrases(text: string, sessionId: string, terms: Map<string, ExtractedTerm>): void {
  // Common technical noun phrase patterns
  const patterns = [
    /\b((?:api|web|app|user|data|state|error|event|file|config|request|response)\s+\w+)\b/gi,
    /\b(\w+\s+(?:service|controller|component|handler|manager|factory|provider|hook|context|store))\b/gi,
    /\b(\w+\s+(?:pattern|approach|strategy|method|technique|solution|implementation))\b/gi,
  ];

  for (const pattern of patterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const phrase = match[1].toLowerCase().trim();
      if (phrase.split(/\s+/).length >= 2 && phrase.length < 40) {
        addTerm(terms, phrase, 'concept', sessionId, '');
      }
    }
  }
}

/**
 * Load search log entries from a JSONL file path.
 */
function loadSearchLog(searchLogPath: string): SearchLogEntry[] {
  try {
    if (!fs.existsSync(searchLogPath)) return [];
    const content = fs.readFileSync(searchLogPath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line) as SearchLogEntry);
  } catch {
    return [];
  }
}

/**
 * Extract search terms from the search log and merge into the terms map.
 */
function extractSearchTerms(
  searchLog: SearchLogEntry[],
  terms: Map<string, ExtractedTerm>,
): void {
  // Count query frequency
  const queryCounts = new Map<string, number>();
  for (const entry of searchLog) {
    const q = entry.query.toLowerCase().trim();
    queryCounts.set(q, (queryCounts.get(q) || 0) + 1);
  }

  // Extract individual words from queries
  const wordCounts = new Map<string, number>();
  Array.from(queryCounts.entries()).forEach(([query, count]) => {
    const words = query.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + count);
    }
  });

  // Add frequent search words as search terms
  Array.from(wordCounts.entries()).forEach(([word, count]) => {
    if (count >= 2) {
      const key = word.toLowerCase();
      if (terms.has(key)) {
        terms.get(key)!.count += count;
      } else {
        terms.set(key, {
          term: word,
          type: 'search',
          count,
          sessions: new Set(),
          contexts: [`Searched ${count} times`],
        });
      }
    }
  });

  // Add full queries that were searched 2+ times
  Array.from(queryCounts.entries()).forEach(([query, count]) => {
    if (count >= 2 && query.split(/\s+/).length >= 2) {
      const key = `search:${query}`;
      terms.set(key, {
        term: query,
        type: 'search',
        count,
        sessions: new Set(),
        contexts: [`Searched ${count} times`],
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Topics section builder
// ---------------------------------------------------------------------------

async function buildTopicsSection(workspaceRoot: string, silent: boolean = false): Promise<Record<string, unknown>> {
  if (!silent) console.log(chalk.gray('   Extracting topics from session files...'));

  const sessionsDir = resolveClaudeSessionsDir(workspaceRoot);
  if (!fs.existsSync(sessionsDir)) {
    if (!silent) console.log(chalk.yellow(`   No Claude sessions dir at ${sessionsDir}`));
    return { totalTerms: 0, totalSessions: 0, byType: {}, terms: [] };
  }

  const sessionFiles = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(sessionsDir, f));

  const terms = new Map<string, ExtractedTerm>();
  let processed = 0;

  for (const sessionFile of sessionFiles) {
    try {
      const { text, sessionId } = extractTopicSessionText(sessionFile);
      extractTerms(text, sessionId, terms);
      extractNounPhrases(text, sessionId, terms);
      processed++;
    } catch {
      // skip files that fail to parse
    }
  }

  // Load and integrate search log
  const searchLogPath = path.join(workspaceRoot, '.claude', 'logs', 'search-log.jsonl');
  const searchLog = loadSearchLog(searchLogPath);
  if (searchLog.length > 0) {
    extractSearchTerms(searchLog, terms);
  }

  // Filter and sort
  const termArray = Array.from(terms.values())
    .filter(t => t.count >= 3)
    .sort((a, b) => b.count - a.count);

  // Group by type for stats
  const byType: Record<string, number> = {};
  for (const t of termArray) {
    byType[t.type] = (byType[t.type] || 0) + 1;
  }

  // Top 200 for the word cloud
  const top200 = termArray.slice(0, 200);
  const maxCount = top200.length > 0 ? top200[0].count : 1;
  const termsOutput = top200.map(t => ({
    text: t.term,
    count: t.count,
    sessions: t.sessions.size,
    type: t.type,
    size: Math.max(12, Math.min(80, 12 + (t.count / maxCount) * 68)),
    contexts: t.contexts.slice(0, 2),
  }));

  if (!silent) {
    console.log(chalk.gray(`   Processed ${processed} sessions, found ${termArray.length} terms (top 200 included)`));
  }

  return {
    totalTerms: termArray.length,
    totalSessions: sessionFiles.length,
    byType,
    terms: termsOutput,
  };
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export async function generateDashboard(): Promise<string> {
  const workspaceRoot = findWorkspaceRoot();

  console.log(chalk.cyan('\n' + '='.repeat(65)));
  console.log(chalk.cyan.bold('  Unified Dashboard Data Generator'));
  console.log(chalk.cyan('='.repeat(65) + '\n'));

  // -----------------------------------------------------------------------
  // 1. Rules
  // -----------------------------------------------------------------------
  console.log(chalk.blue('1/7  Loading rules...'));
  let rules: Rule[] = [];
  const sharedRulesPath = path.join(workspaceRoot, 'scripts', 'self-improvement', 'rules-shared.json');
  const personalRulesPath = path.join(workspaceRoot, 'scripts', 'self-improvement', 'rules.json');
  try {
    // Load team (shared) rules
    if (fs.existsSync(sharedRulesPath)) {
      const shared = (JSON.parse(fs.readFileSync(sharedRulesPath, 'utf8')) as Rule[])
        .map(r => ({ ...r, _scope: 'team' as const }));
      rules.push(...shared);
      console.log(chalk.green(`     Loaded ${shared.length} team rules (rules-shared.json)`));
    }
    // Load personal rules, dedup against shared
    if (fs.existsSync(personalRulesPath)) {
      const sharedIds = new Set(rules.map(r => r.id));
      const personal = (JSON.parse(fs.readFileSync(personalRulesPath, 'utf8')) as Rule[])
        .filter(r => !sharedIds.has(r.id))
        .map(r => ({ ...r, _scope: 'personal' as const }));
      rules.push(...personal);
      console.log(chalk.green(`     Loaded ${personal.length} personal rules (rules.json, deduplicated)`));
    }
    if (rules.length === 0) {
      console.log(chalk.yellow('     No rules found'));
    } else {
      console.log(chalk.green(`     Total: ${rules.length} rules`));
    }
  } catch (err) {
    console.log(chalk.yellow(`     Failed to load rules: ${(err as Error).message}`));
  }

  const rulesSection = buildRulesSection(rules);

  // Build a lookup map for rule id -> text
  const rulesLookup = new Map<string, string>();
  for (const r of rules) {
    rulesLookup.set(r.id, r.text);
  }

  // -----------------------------------------------------------------------
  // 2. Value Events
  // -----------------------------------------------------------------------
  console.log(chalk.blue('2/7  Loading value-events.jsonl...'));
  const valueEventsPath = path.join(workspaceRoot, '.claude', 'logs', 'value-events.jsonl');
  const valueEvents = readJsonlFile(valueEventsPath);
  console.log(chalk.green(`     Loaded ${valueEvents.length} value events`));

  const valueEventsSection = buildValueEventsSection(valueEvents, rulesLookup, rules);

  // -----------------------------------------------------------------------
  // 3. Rule-Match Analytics (formerly Search Analytics)
  // -----------------------------------------------------------------------
  // Source is now rule_injection entries inside value-events.jsonl. The old
  // search-log.jsonl path is no longer read here — see buildSearchSection
  // for the rationale (search CLIs were almost never invoked interactively,
  // and inject-rules already computes Jaccard scores on every prompt).
  console.log(chalk.blue('3/7  Building rule-match analytics from value-events…'));
  const searchSection = buildSearchSection(valueEvents);
  console.log(chalk.green(`     Aggregated ${searchSection.totalQueries} rule-injection events`));

  // -----------------------------------------------------------------------
  // 4-6. Session Embeddings, Reflections, Pipeline stats (parallel Qdrant)
  // -----------------------------------------------------------------------
  console.log(chalk.blue('4/7  Querying Qdrant + pipeline stats (parallel)...'));
  const [sessionsSection, reflectionsSection, pipelineSection] = await Promise.all([
    buildSessionsSection(workspaceRoot),
    buildReflectionsSection(workspaceRoot),
    buildPipelineSection(rules),
  ]);

  // -----------------------------------------------------------------------
  // 7. Topics (session file extraction) — with 24-hour cache
  // -----------------------------------------------------------------------
  console.log(chalk.blue('7/7  Extracting topics...'));
  let topicsSection: Record<string, unknown> = { totalTerms: 0, totalSessions: 0, byType: {}, terms: [] };
  let topicsCached = false;
  const topicCachePath = path.join(workspaceRoot, '.claude', 'visualizations', 'topic-cache.json');
  try {
    if (fs.existsSync(topicCachePath)) {
      const stat = fs.statSync(topicCachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      if (ageMs < TWENTY_FOUR_HOURS) {
        topicsSection = JSON.parse(fs.readFileSync(topicCachePath, 'utf8'));
        topicsCached = true;
        console.log(chalk.green('     Loaded topics from cache (< 24h old)'));
      }
    }
  } catch {
    // cache read failed, will regenerate
  }
  if (!topicsCached) {
    topicsSection = await buildTopicsSection(workspaceRoot);
    try {
      fs.writeFileSync(topicCachePath, JSON.stringify(topicsSection, null, 2));
      console.log(chalk.green('     Topics cached to topic-cache.json'));
    } catch {
      // cache write failed, non-critical
    }
  }

  // -----------------------------------------------------------------------
  // Git-backed snapshot fallback for local-only sections
  // -----------------------------------------------------------------------
  // sessions + reflections come from Qdrant, and topics from local session
  // transcripts — none of which exist in CI (the deploy pipeline has no
  // embeddings service or transcripts). When a fresh compute is empty, reuse the
  // committed dashboard-data.json so a developer's full local generate stays the
  // single source of truth for these. Rules / value-events / pipeline recompute
  // fresh from git-tracked data every run. Refresh: regenerate locally (Qdrant
  // up) and commit dashboard-data.json + topic-cache.json.
  const snapshotPath = path.join(workspaceRoot, '.claude', 'visualizations', 'dashboard-data.json');
  let prevSnapshot: { generatedAt?: string; sessions?: Record<string, unknown>; reflections?: Record<string, unknown>; topics?: Record<string, unknown> } = {};
  try { prevSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch { /* first run / no prior snapshot */ }

  // Track which sections were served from the committed snapshot so the UI can
  // stamp them "as of <snapshot date>" instead of implying they're live.
  // Only fall back when the live section is empty AND the snapshot actually has
  // data — otherwise a genuinely-empty section (e.g. zero reflections) would be
  // wrongly flagged as a stale snapshot.
  const snapshotSections: string[] = [];
  const countOf = (sec: Record<string, unknown> | undefined, key: 'sessions' | 'reflections' | 'topics'): number => {
    if (!sec) return 0;
    if (key === 'sessions') return (sec as { totalEmbedded?: number }).totalEmbedded ?? 0;
    if (key === 'reflections') return (sec as { total?: number }).total ?? 0;
    return (sec as { totalTerms?: number }).totalTerms ?? 0; // topics
  };
  const fromSnapshot = (live: Record<string, unknown>, key: 'sessions' | 'reflections' | 'topics') => {
    const snap = prevSnapshot[key];
    if (countOf(live, key) === 0 && countOf(snap, key) > 0) {
      console.log(chalk.yellow(`     Live ${key} empty (no Qdrant/transcripts here) — reusing committed snapshot`));
      snapshotSections.push(key);
      return snap as Record<string, unknown>;
    }
    return live;
  };
  const sessionsFinal = fromSnapshot(sessionsSection, 'sessions');
  const reflectionsFinal = fromSnapshot(reflectionsSection, 'reflections');
  const topicsFinal = fromSnapshot(topicsSection, 'topics');

  // Per-section freshness: null when everything is live, else the date of the
  // committed snapshot the stale sections were read from.
  const snapshot = snapshotSections.length > 0
    ? { asOf: prevSnapshot.generatedAt || null, sections: snapshotSections }
    : null;

  // -----------------------------------------------------------------------
  // Assemble output
  // -----------------------------------------------------------------------
  const output = {
    generatedAt: new Date().toISOString(),
    topicsCached,
    snapshot,
    rules: rulesSection,
    valueEvents: valueEventsSection,
    search: searchSection,
    sessions: sessionsFinal,
    reflections: reflectionsFinal,
    pipeline: pipelineSection,
    topics: topicsFinal,
  };

  // Write to file
  const outputDir = path.join(workspaceRoot, '.claude', 'visualizations');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = path.join(outputDir, 'dashboard-data.json');
  const jsonData = JSON.stringify(output, null, 2);
  fs.writeFileSync(outputPath, jsonData);

  // Inject data into HTML dashboard so it works when opened via file:// protocol
  const htmlPath = path.join(outputDir, 'dashboard.html');
  // Always rebuild from template to pick up template changes (tabs, charts, styles)
  const templatePath = path.join(__dirname, 'dashboard-template.html');
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, htmlPath);
  } else {
    console.log(chalk.yellow('\nNo dashboard-template.html found — skipping HTML injection'));
  }
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    // Remove any previously injected data block
    html = html.replace(/<!--DASHBOARD_DATA_START-->[\s\S]*?<!--DASHBOARD_DATA_END-->\n?/, '');
    // Inline data as window.DASHBOARD_DATA so file:// protocol works (no fetch needed).
    // Escape </script> and control chars to prevent HTML breakage.
    const safeJson = jsonData
      .replace(/<\/script/gi, '<\\/script')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
    const dataBlock = `<!--DASHBOARD_DATA_START-->\n<script>window.DASHBOARD_DATA = ${safeJson};</script>\n<!--DASHBOARD_DATA_END-->\n`;
    // Use function replacement so `$`/`` $` ``/`$&`/etc. inside dataBlock aren't interpreted as special patterns.
    html = html.replace('</head>', () => dataBlock + '</head>');
    fs.writeFileSync(htmlPath, html);
    console.log(chalk.green(`Data injected into: ${htmlPath}`));
  }

  console.log(chalk.green(`Dashboard data written to: ${outputPath}`));

  return outputPath;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

function printSummary(outputPath: string): void {
  try {
    const data = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, Record<string, unknown>>;

    console.log(chalk.cyan('\n' + '='.repeat(65)));
    console.log(chalk.cyan.bold('  Dashboard Summary'));
    console.log(chalk.cyan('='.repeat(65)));

    // Rules
    const rl = (data.rules?.lifecycle || {}) as Record<string, number>;
    console.log(chalk.blue('\n  Rules'));
    console.log(`    Active:    ${chalk.bold(String(rl.active || 0))}`);
    console.log(`    Proposed:  ${chalk.bold(String(rl.proposed || 0))}`);
    console.log(`    Retired:   ${chalk.bold(String(rl.retired || 0))}`);
    console.log(
      `    Never used: ${chalk.bold(String((data.rules?.neverUsed as unknown[] || []).length))}`,
    );

    // Value Events
    const ve = data.valueEvents || {};
    console.log(chalk.blue('\n  Value Events'));
    console.log(`    Total:     ${chalk.bold(String(ve.total || 0))}`);
    const byType = (ve.byType || {}) as Record<string, number>;
    for (const [type, count] of Object.entries(byType)) {
      console.log(`    ${type}: ${chalk.bold(String(count))}`);
    }

    // Search
    const sr = data.search || {};
    console.log(chalk.blue('\n  Search Activity'));
    console.log(`    Queries:        ${chalk.bold(String(sr.totalQueries || 0))}`);
    console.log(`    Avg results:    ${chalk.bold(String(sr.avgResultCount || 0))}`);
    console.log(`    Avg top score:  ${chalk.bold(String(sr.avgTopScore || 0))}`);

    // Sessions
    const se = data.sessions || {};
    console.log(chalk.blue('\n  Session Embeddings'));
    console.log(`    Sessions:  ${chalk.bold(String(se.totalEmbedded || 0))}`);
    console.log(`    Chunks:    ${chalk.bold(String(se.totalChunks || 0))}`);

    // Reflections
    const rf = data.reflections || {};
    console.log(chalk.blue('\n  Reflections'));
    console.log(`    Total:     ${chalk.bold(String(rf.total || 0))}`);

    // Pipeline
    const pl = data.pipeline || {};
    console.log(chalk.blue('\n  Pipeline'));
    console.log(`    Rules synced:      ${chalk.bold(String(pl.rulesSynced || 0))}`);
    console.log(`    Recent proposed:   ${chalk.bold(String(pl.recentProposed || 0))}`);
    console.log(`    Recent activated:  ${chalk.bold(String(pl.recentActivated || 0))}`);

    // Topics
    const tp = data.topics || {};
    console.log(chalk.blue('\n  Topics'));
    console.log(`    Terms (count>=3): ${chalk.bold(String(tp.totalTerms || 0))}`);
    console.log(`    Sessions scanned: ${chalk.bold(String(tp.totalSessions || 0))}`);

    console.log(chalk.cyan('\n' + '='.repeat(65)));
    console.log(chalk.gray(`  Generated at: ${data.generatedAt ?? ''}`));
    console.log(chalk.gray(`  Output file:  ${outputPath}`));
    console.log(chalk.cyan('='.repeat(65) + '\n'));
  } catch (err) {
    console.log(chalk.yellow(`\nCould not print summary: ${(err as Error).message}`));
  }
}

if (require.main === module) {
  generateDashboard()
    .then(outputPath => {
      printSummary(outputPath);

      // Open the HTML dashboard in the default browser
      const htmlPath = path.join(path.dirname(outputPath), 'dashboard.html');
      if (fs.existsSync(htmlPath)) {
        const { exec } = require('child_process') as typeof import('child_process');
        const cmd = process.platform === 'win32' ? `start "" "${htmlPath}"`
          : process.platform === 'darwin' ? `open "${htmlPath}"`
          : `xdg-open "${htmlPath}"`;
        exec(cmd);
        console.log(chalk.green(`  Opening dashboard: ${htmlPath}\n`));
      }
    })
    .catch(err => {
      console.error(chalk.red('Dashboard generation failed:'), err);
      process.exit(1);
    });
}
