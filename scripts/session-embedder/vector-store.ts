import * as fs from 'fs';
import * as path from 'path';

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
    quality_score?: number;
  };
}

export interface VectorStore {
  entries: VectorEntry[];
  metadata: {
    model: string;
    dimensions: number;
    total_sessions: number;
    total_chunks: number;
    created: string;
    updated: string;
  };
}

export class VectorStoreManager {
  private storePath: string;
  private store: VectorStore;

  constructor(storePath?: string) {
    // Always use workspace root, not current directory
    const workspaceRoot = findWorkspaceRoot();
    this.storePath = storePath || path.join(workspaceRoot, '.claude', 'vector-store', 'sessions.json');
    this.store = this.loadStore();
  }

  private loadStore(): VectorStore {
    if (fs.existsSync(this.storePath)) {
      const data = fs.readFileSync(this.storePath, 'utf8');
      return JSON.parse(data);
    }

    return {
      entries: [],
      metadata: {
        model: 'bge-small-en-v1.5',
        dimensions: 384,
        total_sessions: 0,
        total_chunks: 0,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
    };
  }

  private saveStore(): void {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.store.metadata.updated = new Date().toISOString();
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  addEntry(entry: VectorEntry): void {
    this.store.entries.push(entry);
    this.store.metadata.total_chunks = this.store.entries.length;

    const uniqueSessions = new Set(this.store.entries.map(e => e.session_id));
    this.store.metadata.total_sessions = uniqueSessions.size;

    this.saveStore();
  }

  addBatch(entries: VectorEntry[]): void {
    this.store.entries.push(...entries);
    this.store.metadata.total_chunks = this.store.entries.length;

    const uniqueSessions = new Set(this.store.entries.map(e => e.session_id));
    this.store.metadata.total_sessions = uniqueSessions.size;

    this.saveStore();
  }

  hasSession(sessionId: string): boolean {
    return this.store.entries.some(e => e.session_id === sessionId);
  }

  // --- QdrantVectorStore-compatible surface (so this is a drop-in backend) ---

  /** No-op: the store is loaded in the constructor. Present for interface parity. */
  async initialize(): Promise<void> { /* loaded eagerly in constructor */ }

  /** Unique embedded session ids (parity with QdrantVectorStore.getEmbeddedSessionIds). */
  getEmbeddedSessionIds(): Set<string> {
    return new Set(this.store.entries.map(e => e.session_id));
  }

  /** Reset the store to empty (parity with QdrantVectorStore.deleteCollection). */
  deleteCollection(): void {
    this.store = {
      entries: [],
      metadata: {
        model: 'bge-small-en-v1.5',
        dimensions: 384,
        total_sessions: 0,
        total_chunks: 0,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
    };
    this.saveStore();
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same dimensions');
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      magnitudeA += a[i] * a[i];
      magnitudeB += b[i] * b[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  search(queryEmbedding: number[], topK: number = 10): Array<VectorEntry & { score: number }> {
    // Filter out entries with invalid embeddings
    const validEntries = this.store.entries.filter(
      entry => entry.embedding && entry.embedding.length === this.store.metadata.dimensions
    );

    const results = validEntries.map(entry => ({
      ...entry,
      score: this.cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }

  getStats() {
    return {
      ...this.store.metadata,
      storage_size_mb: (Buffer.byteLength(JSON.stringify(this.store), 'utf8') / 1024 / 1024).toFixed(2),
    };
  }

  getAllSessions(): string[] {
    const sessions = new Set(this.store.entries.map(e => e.session_id));
    return Array.from(sessions);
  }
}
