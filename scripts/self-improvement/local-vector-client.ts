/**
 * Local (Qdrant-free) implementation of the qdrant-client surface used by the
 * self-improvement pipeline. Backed by files — no vector DB server:
 *
 *   - reflections          → .claude/visualizations/_self_reflections.jsonl (records only;
 *                            semantic search over reflections is unused, so no vectors stored)
 *   - rules collection     → no-op writes; nothing reads it now (the rule warmer self-manages
 *                            its own local rule embeddings). getRuleStats counts active rules.
 *   - session-embeddings   → the local VectorStoreManager (.claude/vector-store/sessions.json),
 *                            with Qdrant-style filter support (quality_score range, session_id)
 *
 * Selected via VECTOR_BACKEND=local (see ./vector-client). Behavior matches the
 * Qdrant client for the functions the pipeline actually calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VectorStoreManager, VectorEntry } from '../session-embedder/vector-store';
import {
  appendReflectionMetrics, readReflectionMetrics, ReflectionMetric,
} from '../session-embedder/self-metrics';

function workspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let cur = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(cur, '.claude')) || fs.existsSync(path.join(cur, 'CLAUDE.md'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

// Lazy singleton — the local store can be large; load it once per process.
let _store: VectorStoreManager | null = null;
function store(): VectorStoreManager {
  if (!_store) _store = new VectorStoreManager();
  return _store;
}

/** Build the Qdrant-payload-shaped object a consumer expects from a local entry. */
function toPayload(e: VectorEntry): Record<string, unknown> {
  return {
    id: e.id,
    session_id: e.session_id,
    chunk_text: e.chunk_text,
    date: e.metadata.date,
    chunk_index: e.metadata.chunk_index,
    ...(e.metadata.quality_score != null ? { quality_score: e.metadata.quality_score } : {}),
  };
}

/** Minimal Qdrant filter matcher: supports must[] of {key, range:{gte,lte}} | {key, match:{value}}. */
function matchesFilter(payload: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  const must = (filter.must as Array<Record<string, unknown>>) || [];
  for (const cond of must) {
    const key = cond.key as string;
    const val = payload[key];
    if (cond.match) {
      if (val !== (cond.match as { value: unknown }).value) return false;
    } else if (cond.range) {
      const r = cond.range as { gte?: number; lte?: number };
      const n = typeof val === 'number' ? val : NaN;
      if (r.gte != null && !(n >= r.gte)) return false;
      if (r.lte != null && !(n <= r.lte)) return false;
    }
  }
  return true;
}

// ─── Availability ────────────────────────────────────────────────────
export async function isQdrantAvailable(): Promise<boolean> {
  return true; // local backend is always "available"
}

// ─── Reflections ─────────────────────────────────────────────────────
export async function storeReflection(
  id: string, _embedding: number[], payload: Record<string, unknown>,
): Promise<void> {
  const rec: ReflectionMetric = {
    id,
    date: String(payload.date || new Date().toISOString()),
    failureType: String(payload.failure_type || ''),
    failureDescription: String(payload.failure_description || ''),
    rootCause: String(payload.root_cause || ''),
    preventionRule: String(payload.prevention_rule || ''),
    sessionId: String(payload.session_id || ''),
  };
  appendReflectionMetrics(workspaceRoot(), [rec]);
}

export async function searchReflections(): Promise<Array<{ payload: Record<string, unknown>; score: number }>> {
  return []; // semantic reflection search is unused by the pipeline
}

export async function getReflectionStats(): Promise<{ count: number }> {
  return { count: readReflectionMetrics(workspaceRoot()).length };
}

// ─── Session embeddings ──────────────────────────────────────────────
export async function searchSessions(
  embedding: number[], topK = 10, qualityFilter?: { min?: number; max?: number },
): Promise<Array<{ payload: Record<string, unknown>; score: number }>> {
  // Over-fetch then quality-filter so topK survivors remain after filtering.
  const raw = store().search(embedding, qualityFilter ? topK * 8 : topK);
  const filtered = raw.filter(e => {
    if (!qualityFilter) return true;
    const q = e.metadata.quality_score;
    if (qualityFilter.min != null && !(typeof q === 'number' && q >= qualityFilter.min)) return false;
    if (qualityFilter.max != null && !(typeof q === 'number' && q <= qualityFilter.max)) return false;
    return true;
  });
  return filtered.slice(0, topK).map(e => ({ payload: toPayload(e), score: e.score }));
}

export async function scrollSessions(
  filter?: Record<string, unknown>, limit = 100,
): Promise<Array<{ id: number | string; payload: Record<string, unknown> }>> {
  const out: Array<{ id: number | string; payload: Record<string, unknown> }> = [];
  for (const e of (store() as unknown as { store: { entries: VectorEntry[] } }).store.entries) {
    const payload = toPayload(e);
    if (matchesFilter(payload, filter)) {
      out.push({ id: e.id, payload });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ─── Rules collection (no-op: nothing reads it; warmer self-manages embeddings) ──
export async function storeRule(): Promise<void> { /* no-op */ }
export async function searchRules(): Promise<Array<{ payload: Record<string, unknown>; score: number }>> { return []; }
export async function deleteRule(): Promise<void> { /* no-op */ }
export async function deleteRulesBatch(): Promise<void> { /* no-op */ }
export async function syncAllRules(
  rules: Array<{ id: string; embedding: number[]; payload: Record<string, unknown> }>,
): Promise<number> {
  return rules.length; // report "synced" for callers that log it; nothing to persist
}

export async function getRuleStats(): Promise<{ count: number }> {
  // Count active rules from the rule files (mirrors the warmer's source).
  const dir = path.join(workspaceRoot(), 'scripts', 'self-improvement');
  const load = (f: string): Array<{ id: string; status: string }> => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return []; }
  };
  const shared = load('rules-shared.json');
  const seen = new Set(shared.map(r => r.id));
  const personal = load('rules.json').filter(r => !seen.has(r.id));
  return { count: [...shared, ...personal].filter(r => r.status === 'active').length };
}
