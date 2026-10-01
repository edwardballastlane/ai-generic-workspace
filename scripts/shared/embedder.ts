/**
 * Shared Embedding Module
 *
 * Uses @huggingface/transformers with Xenova/bge-small-en-v1.5 (384-dim)
 * to generate embeddings locally without Ollama.
 *
 * Singleton pipeline: loads once on first embed() call, reused thereafter.
 * Auto-downloads model to ~/.cache/huggingface/ on first use (~130MB).
 */

let pipelineInstance: any = null;

export const VECTOR_DIMENSIONS = 384;

/** Process-lifetime cache to avoid re-embedding identical texts. */
const embeddingCache = new Map<string, number[]>();

/**
 * Get or create the embedding pipeline (singleton).
 */
async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;

  const { pipeline } = await import('@huggingface/transformers');
  pipelineInstance = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
    dtype: 'fp32',
  });

  return pipelineInstance;
}

/**
 * Embed a single text string into a 384-dim vector.
 */
export async function embed(text: string): Promise<number[]> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  const result = Array.from(output.data as Float32Array);
  embeddingCache.set(text, result);
  return result;
}

/**
 * Embed multiple texts in batch for efficiency.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const pipe = await getPipeline();
  const results: number[][] = [];

  for (const text of texts) {
    const cached = embeddingCache.get(text);
    if (cached) {
      results.push(cached);
      continue;
    }
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    const result = Array.from(output.data as Float32Array);
    embeddingCache.set(text, result);
    results.push(result);
  }

  return results;
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
