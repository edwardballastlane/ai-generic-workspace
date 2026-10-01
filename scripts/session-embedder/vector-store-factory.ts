/**
 * Session vector-store backend factory.
 *
 * Selects the embedding store used by the embedder and session search:
 *   VECTOR_BACKEND=qdrant (default) → QdrantVectorStore (server at QDRANT_URL)
 *   VECTOR_BACKEND=local            → VectorStoreManager (file: .claude/vector-store/sessions.json)
 *
 * The local backend needs no Qdrant server — `npm run session:search` and the
 * embedder work entirely from a JSON file. Populate it from an existing Qdrant
 * with `npm run session:migrate-to-local`, or by re-embedding.
 *
 * Caveat: the local store loads all vectors into memory and scores by brute-force
 * cosine. That's fine for modest corpora (tens of thousands of chunks); for very
 * large embedding sets, Qdrant remains the better choice. The dashboard and the
 * rule-injection warmer are already Qdrant-free regardless of this setting.
 */

import { VectorEntry, VectorStoreManager } from './vector-store';
import { QdrantVectorStore } from './qdrant-store';

export type ScoredEntry = VectorEntry & { score: number };

/** Common surface implemented by both backends. Methods may be sync (local) or
 *  async (Qdrant); callers should `await` results to handle both. */
export interface SessionVectorStore {
  initialize(): Promise<void> | void;
  addEntry(entry: VectorEntry): Promise<void> | void;
  addBatch(entries: VectorEntry[]): Promise<void> | void;
  search(queryEmbedding: number[], topK?: number): Promise<ScoredEntry[]> | ScoredEntry[];
  hasSession(sessionId: string): Promise<boolean> | boolean;
  getEmbeddedSessionIds(): Promise<Set<string>> | Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stats shape differs per backend; callers read known fields.
  getStats(): Promise<any> | any;
  getAllSessions(): Promise<string[]> | string[];
  deleteCollection(): Promise<void> | void;
}

export function vectorBackend(): 'local' | 'qdrant' {
  return (process.env.VECTOR_BACKEND || 'qdrant').toLowerCase() === 'local' ? 'local' : 'qdrant';
}

export function createSessionVectorStore(): SessionVectorStore {
  return vectorBackend() === 'local' ? new VectorStoreManager() : new QdrantVectorStore();
}
