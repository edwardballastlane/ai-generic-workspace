/**
 * File-backed self-improvement metrics.
 *
 * The self-improvement dashboard's "sessions embedded", quality distribution and
 * "reflections" sections only ever COUNT/aggregate metadata — they never do
 * vector search. So that metadata can live in two small git-tracked JSONL files
 * instead of Qdrant, which makes the deployed (CI-built) dashboard fully
 * reproducible from git with no vector DB or hosting. Vector SEARCH features
 * keep using their own store.
 *
 *   _self_sessions.jsonl    one row per embedded session (upserted by sessionId)
 *   _self_reflections.jsonl one row per stored reflection (appended; deduped by id)
 *
 * Writers (embedder, quality scorer, reflection generator) call the upsert/append
 * helpers; the dashboard generator reads via aggregate*().
 */

import * as fs from 'fs';
import * as path from 'path';

/** ISO week id, e.g. "2026-W06". Mirrors the helper in dashboard-generator.ts. */
function getISOWeek(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'unknown';
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  } catch {
    return 'unknown';
  }
}

export interface SessionMetric {
  sessionId: string;
  date: string;            // ISO timestamp of the session
  chunks: number;          // embedded chunk count
  scored: number;          // chunks that have a quality_score
  quality: Record<string, number>; // histogram: '1-2'|'3-4'|'5-6'|'7-8'|'9-10' -> count
}

export interface ReflectionMetric {
  id: string;
  date: string;
  failureType: string;
  failureDescription: string;
  rootCause: string;
  preventionRule: string;
  sessionId: string;
}

const VIZ_DIR = ['.claude', 'visualizations'];
export const SESSIONS_FILE = '_self_sessions.jsonl';
export const REFLECTIONS_FILE = '_self_reflections.jsonl';

const EMPTY_HISTOGRAM = (): Record<string, number> => ({ '1-2': 0, '3-4': 0, '5-6': 0, '7-8': 0, '9-10': 0 });

/** Bucket a 1-10 quality score into the dashboard's histogram key. */
export function qualityBucket(score: number): string {
  if (score <= 2) return '1-2';
  if (score <= 4) return '3-4';
  if (score <= 6) return '5-6';
  if (score <= 8) return '7-8';
  return '9-10';
}

function filePath(workspaceRoot: string, name: string): string {
  return path.join(workspaceRoot, ...VIZ_DIR, name);
}

function readJsonl<T>(p: string): T[] {
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    if (!content) return [];
    const out: T[] = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as T); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJsonl(p: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

export function readSessionMetrics(workspaceRoot: string): SessionMetric[] {
  return readJsonl<SessionMetric>(filePath(workspaceRoot, SESSIONS_FILE));
}

export function readReflectionMetrics(workspaceRoot: string): ReflectionMetric[] {
  return readJsonl<ReflectionMetric>(filePath(workspaceRoot, REFLECTIONS_FILE));
}

/**
 * Upsert one session's metric (keyed by sessionId). Merges into any existing row
 * so the embedder (chunks/date) and quality scorer (quality/scored) can update
 * independently. Pass only the fields you know.
 */
export function upsertSessionMetric(workspaceRoot: string, patch: Partial<SessionMetric> & { sessionId: string }): void {
  const p = filePath(workspaceRoot, SESSIONS_FILE);
  const rows = readJsonl<SessionMetric>(p);
  const idx = rows.findIndex(r => r.sessionId === patch.sessionId);
  const base: SessionMetric = idx >= 0 ? rows[idx] : { sessionId: patch.sessionId, date: '', chunks: 0, scored: 0, quality: EMPTY_HISTOGRAM() };
  const merged: SessionMetric = {
    ...base,
    ...patch,
    quality: patch.quality ? patch.quality : base.quality,
  };
  if (idx >= 0) rows[idx] = merged; else rows.push(merged);
  writeJsonl(p, rows);
}

/** Append reflection metrics, de-duplicated by id (idempotent). */
export function appendReflectionMetrics(workspaceRoot: string, records: ReflectionMetric[]): void {
  if (!records.length) return;
  const p = filePath(workspaceRoot, REFLECTIONS_FILE);
  const rows = readJsonl<ReflectionMetric>(p);
  const seen = new Set(rows.map(r => r.id));
  for (const rec of records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    rows.push(rec);
  }
  writeJsonl(p, rows);
}

/** Replace the entire sessions file (used by backfill). */
export function writeSessionMetrics(workspaceRoot: string, rows: SessionMetric[]): void {
  writeJsonl(filePath(workspaceRoot, SESSIONS_FILE), rows);
}

/** Replace the entire reflections file (used by backfill). */
export function writeReflectionMetrics(workspaceRoot: string, rows: ReflectionMetric[]): void {
  writeJsonl(filePath(workspaceRoot, REFLECTIONS_FILE), rows);
}

/**
 * Aggregate session metrics into the exact shape buildSessionsSection produced
 * from Qdrant: { totalEmbedded, totalChunks, qualityDistribution, embeddedOverTime }.
 */
export function aggregateSessions(rows: SessionMetric[]): Record<string, unknown> {
  const qualityDistribution = EMPTY_HISTOGRAM();
  let totalChunks = 0;
  const sessionWeeks = new Map<string, Set<string>>();

  for (const r of rows) {
    totalChunks += r.chunks || 0;
    for (const k of Object.keys(qualityDistribution)) {
      qualityDistribution[k] += (r.quality && r.quality[k]) || 0;
    }
    if (r.date && r.sessionId) {
      const week = getISOWeek(r.date);
      if (!sessionWeeks.has(week)) sessionWeeks.set(week, new Set());
      sessionWeeks.get(week)!.add(r.sessionId);
    }
  }

  const embeddedOverTime = Array.from(sessionWeeks.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, sessions]) => ({ week, sessions: sessions.size }));

  return {
    totalEmbedded: rows.length,
    totalChunks,
    qualityDistribution,
    embeddedOverTime,
  };
}

/**
 * Aggregate reflection metrics into the shape buildReflectionsSection produced:
 * { total, byFailureType, recentReflections } (top 20 by date desc).
 */
export function aggregateReflections(rows: ReflectionMetric[]): Record<string, unknown> {
  const byFailureType: Record<string, number> = {};
  for (const r of rows) {
    if (r.failureType) byFailureType[r.failureType] = (byFailureType[r.failureType] || 0) + 1;
  }
  const recentReflections = rows
    .filter(r => r.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 20)
    .map(r => ({
      date: r.date,
      failureDescription: r.failureDescription || '',
      rootCause: r.rootCause || '',
      preventionRule: r.preventionRule || '',
      sessionId: r.sessionId || '',
    }));
  return { total: rows.length, byFailureType, recentReflections };
}
