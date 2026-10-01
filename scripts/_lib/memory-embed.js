'use strict';

/**
 * memory-embed — opt-in local embedder for semantic memory search.
 *
 * Mirrors scripts/shared/embedder.ts (Xenova/bge-small-en-v1.5, 384-dim) but in plain
 * JS via a dynamic import, so the dependency-free MCP server can use it WITHOUT ts-node.
 * The model (~130MB, cached under ~/.cache/huggingface) loads lazily on first embed —
 * and only ever when LANE_MEMORY_SEMANTIC=1, so the default keyword/BM25 path never
 * pays for it. Any failure (no model, offline, dep missing) throws and callers fall
 * back to BM25.
 */

let pipelinePromise = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
    })();
  }
  return pipelinePromise;
}

/** Embed a batch of texts → array of 384-dim vectors (mean-pooled, normalized). */
async function embedBatch(texts) {
  const pipe = await getPipeline();
  const out = [];
  for (const t of texts) {
    const res = await pipe(String(t || ''), { pooling: 'mean', normalize: true });
    out.push(Array.from(res.data));
  }
  return out;
}

/** Semantic search is opt-in via env flag (off by default). */
function semanticEnabled() {
  return process.env.LANE_MEMORY_SEMANTIC === '1';
}

module.exports = { getPipeline, embedBatch, semanticEnabled };
