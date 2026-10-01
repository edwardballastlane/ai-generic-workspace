#!/usr/bin/env ts-node
/**
 * Backfill the file-backed self-metrics (_self_sessions.jsonl,
 * _self_reflections.jsonl) from the current local Qdrant. One-time bootstrap so
 * the file-backed dashboard starts with all existing data; safe to re-run (it
 * fully replaces both files from Qdrant's current contents).
 *
 * Usage: npx ts-node scripts/session-embedder/self-metrics-backfill.ts
 *        (or: npm run self:metrics:backfill)
 */

import * as fs from 'fs';
import * as path from 'path';
import { QDRANT_URL, qdrantHeaders } from '../shared/qdrant';
import {
  SessionMetric, ReflectionMetric, qualityBucket,
  writeSessionMetrics, writeReflectionMetrics, aggregateSessions, aggregateReflections,
} from './self-metrics';

function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude')) || fs.existsSync(path.join(current, 'CLAUDE.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

interface Point { payload: Record<string, unknown> }

/** Scroll an entire Qdrant collection, returning all points' payloads. */
async function scrollAll(collection: string, fields: string[]): Promise<Point[]> {
  const points: Point[] = [];
  let offset: string | number | null = null;
  while (true) {
    const body: Record<string, unknown> = { limit: 1000, with_payload: { include: fields }, with_vector: false };
    if (offset !== null) body.offset = offset;
    const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const data = await res.json() as { result?: { points?: Point[]; next_page_offset?: string | number | null } };
    const batch = data.result?.points || [];
    points.push(...batch);
    offset = data.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

async function backfillSessions(root: string): Promise<SessionMetric[]> {
  const points = await scrollAll('session-embeddings', ['session_id', 'date', 'quality_score']);
  const bySession = new Map<string, SessionMetric>();
  for (const p of points) {
    const sid = p.payload.session_id as string | undefined;
    if (!sid) continue;
    let m = bySession.get(sid);
    if (!m) {
      m = { sessionId: sid, date: '', chunks: 0, scored: 0, quality: { '1-2': 0, '3-4': 0, '5-6': 0, '7-8': 0, '9-10': 0 } };
      bySession.set(sid, m);
    }
    m.chunks++;
    if (!m.date && p.payload.date) m.date = String(p.payload.date);
    const qs = p.payload.quality_score as number | undefined;
    if (qs !== undefined && qs !== null) {
      m.scored++;
      m.quality[qualityBucket(qs)]++;
    }
  }
  const rows = Array.from(bySession.values());
  writeSessionMetrics(root, rows);
  return rows;
}

async function backfillReflections(root: string): Promise<ReflectionMetric[]> {
  const points = await scrollAll('reflections', ['id', 'failure_type', 'failure_description', 'root_cause', 'prevention_rule', 'date', 'session_id']);
  const rows: ReflectionMetric[] = points.map(p => ({
    id: String(p.payload.id || ''),
    date: String(p.payload.date || ''),
    failureType: String(p.payload.failure_type || ''),
    failureDescription: String(p.payload.failure_description || ''),
    rootCause: String(p.payload.root_cause || ''),
    preventionRule: String(p.payload.prevention_rule || ''),
    sessionId: String(p.payload.session_id || ''),
  }));
  writeReflectionMetrics(root, rows);
  return rows;
}

async function main() {
  const root = findWorkspaceRoot();
  console.log(`Backfilling self-metrics from Qdrant at ${QDRANT_URL} …`);
  const sessions = await backfillSessions(root);
  const reflections = await backfillReflections(root);
  const sAgg = aggregateSessions(sessions) as { totalEmbedded: number; totalChunks: number };
  const rAgg = aggregateReflections(reflections) as { total: number };
  console.log(`  sessions:    ${sessions.length} rows  (totalEmbedded=${sAgg.totalEmbedded}, totalChunks=${sAgg.totalChunks})`);
  console.log(`  reflections: ${reflections.length} rows (total=${rAgg.total})`);
  console.log('Wrote _self_sessions.jsonl + _self_reflections.jsonl. Commit them to publish.');
}

main().catch(err => { console.error('backfill failed:', err); process.exit(1); });
