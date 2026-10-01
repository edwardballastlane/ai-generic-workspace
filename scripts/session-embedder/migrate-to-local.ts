#!/usr/bin/env ts-node
/**
 * Migrate session embeddings from Qdrant into the local file store
 * (.claude/vector-store/sessions.json), so `VECTOR_BACKEND=local`
 * session search/embedding works without re-embedding from transcripts.
 *
 * Reverse of migrate-to-qdrant.ts. Replaces the local store contents.
 *
 * Usage: npm run session:migrate-to-local
 */

import { QDRANT_URL, qdrantHeaders } from '../shared/qdrant';
import { VectorEntry, VectorStoreManager } from './vector-store';

const COLLECTION = 'session-embeddings';

async function scrollAll(): Promise<Array<{ payload: Record<string, unknown>; vector: number[] }>> {
  const out: Array<{ payload: Record<string, unknown>; vector: number[] }> = [];
  let offset: string | number | null = null;
  while (true) {
    const body: Record<string, unknown> = { limit: 1000, with_payload: true, with_vector: true };
    if (offset !== null) body.offset = offset;
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant scroll failed: ${res.status} ${res.statusText}`);
    const data = await res.json() as { result?: { points?: Array<{ payload: Record<string, unknown>; vector: number[] }>; next_page_offset?: string | number | null } };
    const batch = data.result?.points || [];
    out.push(...batch);
    offset = data.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return out;
}

async function main() {
  console.log(`Migrating session-embeddings from Qdrant (${QDRANT_URL}) → local file store…`);
  const points = await scrollAll();
  if (points.length === 0) {
    console.log('No points found in Qdrant — nothing to migrate.');
    return;
  }

  const entries: VectorEntry[] = points
    .filter(p => Array.isArray(p.vector) && p.vector.length === 384)
    .map(p => ({
      id: String(p.payload.id || ''),
      session_id: String(p.payload.session_id || ''),
      chunk_text: String(p.payload.chunk_text || ''),
      embedding: p.vector,
      metadata: {
        date: String(p.payload.date || ''),
        chunk_index: Number(p.payload.chunk_index || 0),
        ...(p.payload.quality_score != null ? { quality_score: Number(p.payload.quality_score) } : {}),
      },
    }));

  const store = new VectorStoreManager();
  store.deleteCollection(); // start clean so re-runs don't duplicate
  store.addBatch(entries);

  const stats = store.getStats() as { total_sessions: number; total_chunks: number; storage_size_mb: string };
  console.log(`  Migrated ${entries.length} chunks across ${stats.total_sessions} sessions (${stats.storage_size_mb} MB).`);
  console.log('  Local store ready. Use it with: VECTOR_BACKEND=local npm run session:search "query"');
}

main().catch(err => { console.error('migrate-to-local failed:', err); process.exit(1); });
