/**
 * Shared Qdrant helper for the self-improvement system.
 * Manages the 'reflections', 'rules', and 'session-embeddings' collections.
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const REFLECTIONS_COLLECTION = 'reflections';
const SESSIONS_COLLECTION = 'session-embeddings';
const RULES_COLLECTION = 'rules';
const VECTOR_SIZE = 384;

function qdrantHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) {
    headers['api-key'] = QDRANT_API_KEY;
  }
  return headers;
}

/**
 * Ensure a Qdrant collection exists, creating it if needed.
 */
async function ensureCollection(name: string): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${name}`, { headers: qdrantHeaders() });
  if (!res.ok) {
    const createRes = await fetch(`${QDRANT_URL}/collections/${name}`, {
      method: 'PUT',
      headers: qdrantHeaders(),
      body: JSON.stringify({
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      }),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create collection ${name}: ${createRes.statusText}`);
    }
  }
}

/**
 * Convert a string ID to a numeric hash for Qdrant.
 */
function stringToId(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
  }
  return Math.abs(hash >>> 0);
}

/**
 * Check if Qdrant is reachable.
 */
export async function isQdrantAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${QDRANT_URL}/collections`, {
      headers: qdrantHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Store a reflection in the reflections collection.
 */
export async function storeReflection(
  id: string,
  embedding: number[],
  payload: Record<string, unknown>
): Promise<void> {
  await ensureCollection(REFLECTIONS_COLLECTION);

  const res = await fetch(`${QDRANT_URL}/collections/${REFLECTIONS_COLLECTION}/points`, {
    method: 'PUT',
    headers: qdrantHeaders(),
    body: JSON.stringify({
      points: [{
        id: stringToId(id),
        vector: embedding,
        payload: { ...payload, id },
      }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to store reflection: ${res.statusText}`);
  }
}

/**
 * Search reflections by embedding vector.
 */
export async function searchReflections(
  embedding: number[],
  topK: number = 3,
  scoreThreshold: number = 0.6
): Promise<Array<{ payload: Record<string, unknown>; score: number }>> {
  await ensureCollection(REFLECTIONS_COLLECTION);

  const res = await fetch(`${QDRANT_URL}/collections/${REFLECTIONS_COLLECTION}/points/search`, {
    method: 'POST',
    headers: qdrantHeaders(),
    body: JSON.stringify({
      vector: embedding,
      limit: topK,
      with_payload: true,
      score_threshold: scoreThreshold,
    }),
  });

  if (!res.ok) return [];

  const data = await res.json() as { result: Array<{ payload: Record<string, unknown>; score: number }> };
  return data.result;
}

/**
 * Search session embeddings by vector with optional quality filter.
 */
export async function searchSessions(
  embedding: number[],
  topK: number = 10,
  qualityFilter?: { min?: number; max?: number }
): Promise<Array<{ payload: Record<string, unknown>; score: number }>> {
  const filter: Record<string, unknown> = {};

  if (qualityFilter) {
    const must: Array<Record<string, unknown>> = [];
    if (qualityFilter.min !== undefined) {
      must.push({ key: 'quality_score', range: { gte: qualityFilter.min } });
    }
    if (qualityFilter.max !== undefined) {
      must.push({ key: 'quality_score', range: { lte: qualityFilter.max } });
    }
    if (must.length > 0) {
      filter.must = must;
    }
  }

  const body: Record<string, unknown> = {
    vector: embedding,
    limit: topK,
    with_payload: true,
  };
  if (Object.keys(filter).length > 0) {
    body.filter = filter;
  }

  const res = await fetch(`${QDRANT_URL}/collections/${SESSIONS_COLLECTION}/points/search`, {
    method: 'POST',
    headers: qdrantHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) return [];

  const data = await res.json() as { result: Array<{ payload: Record<string, unknown>; score: number }> };
  return data.result;
}

/**
 * Scroll through all points in session-embeddings with optional filter.
 */
export async function scrollSessions(
  filter?: Record<string, unknown>,
  limit: number = 100
): Promise<Array<{ id: number | string; payload: Record<string, unknown> }>> {
  const points: Array<{ id: number | string; payload: Record<string, unknown> }> = [];
  let offset: string | number | null = null;

  while (true) {
    const body: Record<string, unknown> = { limit, with_payload: true };
    if (offset !== null) body.offset = offset;
    if (filter) body.filter = filter;

    const res = await fetch(`${QDRANT_URL}/collections/${SESSIONS_COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) break;

    const data = await res.json() as { result: { points: Array<{ id: number | string; payload: Record<string, unknown> }>; next_page_offset?: string | number } };
    points.push(...data.result.points);

    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }

  return points;
}

/**
 * Get reflections collection stats.
 */
export async function getReflectionStats(): Promise<{ count: number }> {
  try {
    await ensureCollection(REFLECTIONS_COLLECTION);
    const res = await fetch(`${QDRANT_URL}/collections/${REFLECTIONS_COLLECTION}`, { headers: qdrantHeaders() });
    if (!res.ok) return { count: 0 };
    const data = await res.json() as { result: { points_count: number } };
    return { count: data.result.points_count };
  } catch {
    return { count: 0 };
  }
}

// ─── Rules Collection ────────────────────────────────────────────────

/**
 * Upsert a rule into the rules collection.
 */
export async function storeRule(
  id: string,
  embedding: number[],
  payload: Record<string, unknown>
): Promise<void> {
  await ensureCollection(RULES_COLLECTION);

  const res = await fetch(`${QDRANT_URL}/collections/${RULES_COLLECTION}/points`, {
    method: 'PUT',
    headers: qdrantHeaders(),
    body: JSON.stringify({
      points: [{
        id: stringToId(id),
        vector: embedding,
        payload: { ...payload, rule_id: id },
      }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to store rule: ${res.statusText}`);
  }
}

/**
 * Semantic search for rules by embedding vector.
 */
export async function searchRules(
  embedding: number[],
  topK: number = 8,
  statusFilter: string = 'active'
): Promise<Array<{ payload: Record<string, unknown>; score: number }>> {
  await ensureCollection(RULES_COLLECTION);

  const body: Record<string, unknown> = {
    vector: embedding,
    limit: topK,
    with_payload: true,
  };

  if (statusFilter) {
    body.filter = {
      must: [{ key: 'status', match: { value: statusFilter } }],
    };
  }

  const res = await fetch(`${QDRANT_URL}/collections/${RULES_COLLECTION}/points/search`, {
    method: 'POST',
    headers: qdrantHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) return [];

  const data = await res.json() as { result: Array<{ payload: Record<string, unknown>; score: number }> };
  return data.result;
}

/**
 * Delete a rule from the rules collection by its string ID.
 */
export async function deleteRule(id: string): Promise<void> {
  await ensureCollection(RULES_COLLECTION);

  const res = await fetch(`${QDRANT_URL}/collections/${RULES_COLLECTION}/points/delete`, {
    method: 'POST',
    headers: qdrantHeaders(),
    body: JSON.stringify({
      points: [stringToId(id)],
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to delete rule: ${res.statusText}`);
  }
}

/**
 * Batch delete rules from the rules collection by their string IDs.
 */
export async function deleteRulesBatch(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await ensureCollection(RULES_COLLECTION);
  const numericIds = ids.map(id => stringToId(id));
  const res = await fetch(`${QDRANT_URL}/collections/${RULES_COLLECTION}/points/delete`, {
    method: 'POST',
    headers: qdrantHeaders(),
    body: JSON.stringify({ points: numericIds }),
  });
  if (!res.ok) {
    throw new Error(`Failed to batch delete rules: ${res.statusText}`);
  }
}

/**
 * Bulk upsert all rules to Qdrant (idempotent sync).
 * Processes in batches of 50 to avoid payload limits.
 */
export async function syncAllRules(
  rules: Array<{ id: string; embedding: number[]; payload: Record<string, unknown> }>
): Promise<number> {
  await ensureCollection(RULES_COLLECTION);

  const BATCH_SIZE = 50;
  let synced = 0;

  for (let i = 0; i < rules.length; i += BATCH_SIZE) {
    const batch = rules.slice(i, i + BATCH_SIZE);
    const points = batch.map(r => ({
      id: stringToId(r.id),
      vector: r.embedding,
      payload: { ...r.payload, rule_id: r.id },
    }));

    const res = await fetch(`${QDRANT_URL}/collections/${RULES_COLLECTION}/points`, {
      method: 'PUT',
      headers: qdrantHeaders(),
      body: JSON.stringify({ points }),
    });

    if (res.ok) {
      synced += batch.length;
    }
  }

  return synced;
}

/**
 * Get rules collection stats.
 */
export async function getRuleStats(): Promise<{ count: number }> {
  try {
    await ensureCollection(RULES_COLLECTION);
    const res = await fetch(`${QDRANT_URL}/collections/${RULES_COLLECTION}`, { headers: qdrantHeaders() });
    if (!res.ok) return { count: 0 };
    const data = await res.json() as { result: { points_count: number } };
    return { count: data.result.points_count };
  } catch {
    return { count: 0 };
  }
}
