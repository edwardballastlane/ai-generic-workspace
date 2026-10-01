import * as fs from 'fs';
import * as path from 'path';
import { QDRANT_URL, qdrantHeaders } from '../shared/qdrant';

const COLLECTION_NAME = 'session-embeddings';
const VECTOR_SIZE = 384; // bge-small-en-v1.5 dimensions

function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude'))) return current;
    if (fs.existsSync(path.join(current, 'CLAUDE.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export interface VectorEntry {
  id: string;
  session_id: string;
  chunk_text: string;
  embedding: number[];
  metadata: {
    date: string;
    files?: string[];
    tools?: string[];
    chunk_index: number;
  };
}

export class QdrantVectorStore {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, { headers: qdrantHeaders() });

      if (!response.ok) {
        // Create collection
        await this.createCollection();
      }

      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize Qdrant:', error);
      throw error;
    }
  }

  private async createCollection(): Promise<void> {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create collection: ${response.statusText}`);
    }
  }

  // Strip lone surrogates that break JSON serialization
  private sanitizeText(text: string): string {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  }

  async addEntry(entry: VectorEntry): Promise<void> {
    await this.initialize();

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        points: [
          {
            id: this.stringToId(entry.id),
            vector: entry.embedding,
            payload: {
              id: entry.id,
              session_id: entry.session_id,
              chunk_text: this.sanitizeText(entry.chunk_text),
              date: entry.metadata.date,
              chunk_index: entry.metadata.chunk_index,
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add entry: ${response.statusText}`);
    }
  }

  async addBatch(entries: VectorEntry[]): Promise<void> {
    await this.initialize();

    const points = entries.map(entry => ({
      id: this.stringToId(entry.id),
      vector: entry.embedding,
      payload: {
        id: entry.id,
        session_id: entry.session_id,
        chunk_text: this.sanitizeText(entry.chunk_text),
        date: entry.metadata.date,
        chunk_index: entry.metadata.chunk_index,
      },
    }));

    // Qdrant caps the HTTP body at 32MB by default. Long CC transcripts can
    // produce thousands of chunks and blow past that in a single PUT, so we
    // split into sub-batches. 1000 points keeps us well under the cap.
    const SUB_BATCH = 1000;
    for (let i = 0; i < points.length; i += SUB_BATCH) {
      const slice = points.slice(i, i + SUB_BATCH);
      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
        method: 'PUT',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ points: slice }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to add batch: ${response.statusText} - ${errorText}`);
      }
    }
  }

  async deleteCollection(): Promise<void> {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      method: 'DELETE',
      headers: qdrantHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete collection: ${response.statusText}`);
    }

    this.initialized = false;
  }

  async search(queryEmbedding: number[], topK: number = 10): Promise<Array<VectorEntry & { score: number }>> {
    await this.initialize();

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        vector: queryEmbedding,
        limit: topK,
        with_payload: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }

    const data = await response.json() as any;

    return data.result.map((item: any) => ({
      id: item.payload.id,
      session_id: item.payload.session_id,
      chunk_text: (item.payload.chunk_text as string) || "",
      embedding: item.vector || [],
      metadata: {
        date: item.payload.date,
        chunk_index: item.payload.chunk_index,
      },
      score: item.score,
    }));
  }

  async hasSession(sessionId: string): Promise<boolean> {
    await this.initialize();

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        vector: new Array(VECTOR_SIZE).fill(0),
        limit: 1,
        filter: {
          must: [
            {
              key: 'session_id',
              match: {
                value: sessionId,
              },
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Filter search failed: ${response.statusText}`);
    }

    const data = await response.json() as any;
    return data.result.length > 0;
  }

  async getStats(): Promise<any> {
    await this.initialize();

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, { headers: qdrantHeaders() });

    if (!response.ok) {
      throw new Error(`Failed to get stats: ${response.statusText}`);
    }

    const data = await response.json() as any;

    return {
      model: 'bge-small-en-v1.5',
      dimensions: VECTOR_SIZE,
      total_sessions: 'N/A', // Would need separate query to count unique sessions
      total_chunks: data.result.points_count,
      storage_size_mb: (data.result.points_count * VECTOR_SIZE * 4 / 1024 / 1024).toFixed(2),
      qdrant_status: 'healthy',
    };
  }

  async getAllSessions(): Promise<string[]> {
    const sessionIds = await this.getEmbeddedSessionIds();
    return Array.from(sessionIds);
  }

  /**
   * Fetch all embedded session IDs from Qdrant in a single scrolling pass.
   * Returns a Set for O(1) lookup. Much faster than per-session hasSession() calls.
   */
  async getEmbeddedSessionIds(): Promise<Set<string>> {
    await this.initialize();

    const sessionIds = new Set<string>();
    let offset: string | number | null = null;
    const PAGE_SIZE = 250;

    while (true) {
      const body: Record<string, unknown> = {
        limit: PAGE_SIZE,
        with_payload: { include: ['session_id'] },
        with_vector: false,
      };
      if (offset !== null) {
        body.offset = offset;
      }

      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
        method: 'POST',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Scroll failed: ${response.statusText}`);
      }

      const data = await response.json() as any;
      const points = data.result?.points || [];

      for (const point of points) {
        if (point.payload?.session_id) {
          sessionIds.add(point.payload.session_id);
        }
      }

      // next_page_offset is null when there are no more pages
      offset = data.result?.next_page_offset ?? null;
      if (offset === null || points.length === 0) break;
    }

    return sessionIds;
  }

  private stringToId(str: string): number {
    // Convert string to numeric ID using hash (safe uint64 range)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
    }
    // Convert to positive number and keep within safe integer range
    return Math.abs(hash >>> 0); // Use unsigned right shift to get positive 32-bit int
  }
}
