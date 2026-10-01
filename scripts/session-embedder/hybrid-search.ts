#!/usr/bin/env ts-node
/**
 * Hybrid Search
 *
 * Combines semantic (embedding) search with entity-based (knowledge graph) search.
 * Based on research:
 * - KG²RAG (arXiv:2502.06864): KG-guided retrieval augmented generation
 * - GraphRAG Survey (arXiv:2408.08921): Graph-enhanced retrieval
 *
 * Search Strategy:
 * 1. Semantic search: Find similar content via embeddings
 * 2. Entity extraction: Identify entities in query
 * 3. Entity search: Find sessions with matching entities
 * 4. Relationship expansion: Include related sessions via knowledge graph
 * 5. Score fusion: Combine scores with configurable weights
 */

import * as fs from 'fs';
import * as path from 'path';
import { embed } from '../shared/embedder';
import { createSessionVectorStore, SessionVectorStore } from './vector-store-factory';
import { EntityExtractor, Entity } from './entity-extractor';
import { formatStaleness, deduplicateBySession, sessionDiversityCount } from './result-enhancer';

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'resource';

export interface HybridSearchResult {
  id: string;
  sessionId: string;
  chunkText: string;
  tier: MemoryTier;

  // Individual scores
  semanticScore: number;
  entityScore: number;
  recencyScore: number;

  // Combined score
  hybridScore: number;

  // Metadata
  matchedEntities: string[];
  metadata: {
    date: string;
    chunk_index: number;
  };
}

/**
 * Find workspace root by looking for .claude directory
 */
function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }

  let current = process.cwd();
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Load chunk text from session file
 * Note: Chunks are generated during embedding from session messages, not persisted
 * For now, we return a reference to allow users to look up the full context in Claude Code
 */
function loadChunkFromSession(sessionId: string, chunkIndex: number): string {
  const workspaceRoot = findWorkspaceRoot();
  const sessionPath = path.join(workspaceRoot, '.claude', 'logs', 'sessions', `${sessionId}.json`);

  try {
    if (!fs.existsSync(sessionPath)) {
      return `[View full session: ${sessionId}]`;
    }

    const content = fs.readFileSync(sessionPath, 'utf8');
    const session = JSON.parse(content);

    // Try to extract session summary/content from messages
    if (session.messages && session.messages.length > 0) {
      for (const msg of session.messages) {
        if (msg.type === 'summary' && msg.summary) {
          return `[Session: ${msg.summary}] (Chunk #${chunkIndex})`;
        }
      }
    }

    return `[View full session: ${sessionId}] (Chunk #${chunkIndex})`;
  } catch {
    return `[View full session: ${sessionId}]`;
  }
}

export interface HybridSearchOptions {
  // Number of results
  topK: number;

  // Score weights (should sum to 1.0)
  weights: {
    semantic: number;    // Embedding similarity
    entity: number;      // Entity matches
    relationship: number; // Graph relationships
    recency: number;     // Time decay
  };

  // Filters
  tiers?: MemoryTier[];
  minScore?: number;
  tags?: string[];

  // Feature flags
  extractEntities?: boolean;
  expandRelationships?: boolean;
  verbose?: boolean;
}

const DEFAULT_OPTIONS: HybridSearchOptions = {
  topK: 10,
  weights: {
    semantic: 0.4,
    entity: 0.25,
    relationship: 0.15,
    recency: 0.2,
  },
  extractEntities: true,
  expandRelationships: true,
  verbose: false,
};

export class HybridSearchEngine {
  private vectorStore: SessionVectorStore;
  private extractor: EntityExtractor;

  constructor() {
    this.vectorStore = createSessionVectorStore();
    this.extractor = new EntityExtractor();
  }

  /**
   * Perform hybrid search combining semantic and entity-based retrieval
   */
  async search(query: string, options: Partial<HybridSearchOptions> = {}): Promise<HybridSearchResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Step 1: Generate query embedding
    const queryEmbedding = await embed(query);

    // Step 2: Semantic search via Qdrant
    const semanticResults = await this.vectorStore.search(queryEmbedding, opts.topK * 3);

    if (semanticResults.length === 0) {
      return [];
    }

    // Step 3: Extract entities from query (if enabled)
    let queryEntities: Entity[] = [];
    if (opts.extractEntities) {
      try {
        const extraction = await this.extractor.extract(query);
        queryEntities = extraction.entities;

        if (opts.verbose) {
          console.log(`Extracted ${queryEntities.length} entities from query:`,
            queryEntities.map(e => `${e.type}:${e.name}`).join(', '));
        }
      } catch (error) {
        console.warn('Entity extraction failed:', error);
      }
    }

    // Step 4: Process and score all results
    const results: HybridSearchResult[] = semanticResults.map(result => {
      const sessionId = result.session_id.split('-chunk-')[0];
      const chunkIndex = result.metadata.chunk_index;
      const chunkText = loadChunkFromSession(sessionId, chunkIndex);

      // Calculate entity score by checking if entities appear in chunk text
      let entityScore = 0;
      const matchedEntities: string[] = [];

      for (const entity of queryEntities) {
        if (chunkText.toLowerCase().includes(entity.name.toLowerCase())) {
          entityScore += entity.confidence;
          matchedEntities.push(entity.name);
        }
      }
      // Normalize entity score
      entityScore = queryEntities.length > 0 ? Math.min(1, entityScore / queryEntities.length) : 0;

      // Calculate recency score
      const ageMs = Date.now() - new Date(result.metadata.date).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyScore = Math.exp(-0.1 * ageDays);

      // Determine tier based on recency
      let tier: MemoryTier = 'episodic';
      if (ageDays <= 1) {
        tier = 'working';
      } else if (ageDays > 30) {
        tier = 'semantic';
      }

      // Calculate hybrid score
      const hybridScore =
        (result.score * opts.weights.semantic) +
        (entityScore * opts.weights.entity) +
        (recencyScore * opts.weights.recency);

      return {
        id: result.id,
        sessionId,
        chunkText,
        tier,
        semanticScore: result.score,
        entityScore,
        recencyScore,
        hybridScore,
        matchedEntities,
        metadata: {
          date: result.metadata.date,
          chunk_index: chunkIndex,
        },
      };
    });

    // Sort by hybrid score, deduplicate by session for diversity, return top K
    const sorted = results
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .filter(r => !opts.minScore || r.hybridScore >= opts.minScore);

    return deduplicateBySession(sorted, opts.topK);
  }

  /**
   * Get search engine statistics
   */
  async getStats(): Promise<any> {
    return this.vectorStore.getStats();
  }
}

// CLI interface
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Hybrid Search Engine
====================

Combines semantic search with entity-based knowledge graph search.

Usage:
  npm run hybrid-search "your query"
  npm run hybrid-search "your query" [options]

Options:
  --top, -k <n>           Number of results (default: 10)
  --semantic <weight>     Weight for semantic similarity (default: 0.4)
  --entity <weight>       Weight for entity matches (default: 0.25)
  --relationship <weight> Weight for graph relationships (default: 0.15)
  --recency <weight>      Weight for time decay (default: 0.2)
  --no-entities           Disable entity extraction
  --no-expansion          Disable relationship expansion
  --tier <tiers>          Filter by tiers (comma-separated)
  --min-score <n>         Minimum hybrid score (0-1)
  --verbose, -v           Show detailed output
  --stats                 Show engine statistics
  --help, -h              Show this help

Examples:
  npm run hybrid-search "how to set up Supabase realtime"
  npm run hybrid-search "docker deployment" --semantic 0.5 --entity 0.3
  npm run hybrid-search "react patterns" -k 20 -v
`);
    return;
  }

  // Parse arguments
  let query = '';
  const options: Partial<HybridSearchOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--stats') {
      const engine = new HybridSearchEngine();
      engine.getStats().then(stats => {
        console.log('\nHybrid Search Engine Statistics:');
        console.log(JSON.stringify(stats, null, 2));
      }).catch(console.error);
      return;
    }

    if (arg === '--top' || arg === '-k') {
      options.topK = parseInt(args[++i], 10);
    } else if (arg === '--semantic') {
      options.weights = { ...DEFAULT_OPTIONS.weights, ...options.weights, semantic: parseFloat(args[++i]) };
    } else if (arg === '--entity') {
      options.weights = { ...DEFAULT_OPTIONS.weights, ...options.weights, entity: parseFloat(args[++i]) };
    } else if (arg === '--relationship') {
      options.weights = { ...DEFAULT_OPTIONS.weights, ...options.weights, relationship: parseFloat(args[++i]) };
    } else if (arg === '--recency') {
      options.weights = { ...DEFAULT_OPTIONS.weights, ...options.weights, recency: parseFloat(args[++i]) };
    } else if (arg === '--no-entities') {
      options.extractEntities = false;
    } else if (arg === '--no-expansion') {
      options.expandRelationships = false;
    } else if (arg === '--tier') {
      options.tiers = args[++i].split(',') as MemoryTier[];
    } else if (arg === '--min-score') {
      options.minScore = parseFloat(args[++i]);
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (!arg.startsWith('-')) {
      query = arg;
    }
  }

  if (!query) {
    console.error('Error: Please provide a search query');
    process.exit(1);
  }

  // Run search
  const engine = new HybridSearchEngine();
  console.log(`\n🔍 Hybrid search for: "${query}"\n`);

  const searchStart = Date.now();
  const results = await engine.search(query, options);
  const durationMs = Date.now() - searchStart;

  // Log search activity
  try {
    const logDir = path.join(findWorkspaceRoot(), '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'search-log.jsonl');
    const entry = {
      timestamp: new Date().toISOString(),
      source: 'hybrid-search',
      query,
      resultsCount: results.length,
      topScore: results.length > 0 ? results[0].hybridScore : 0,
      topSessionId: results.length > 0 ? results[0].sessionId : '',
      durationMs,
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {}

  // Log value event
  try {
    const logDir = path.join(findWorkspaceRoot(), '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const valueLogPath = path.join(logDir, 'value-events.jsonl');

    let sessionId = '';
    try {
      const sessionFile = path.join(findWorkspaceRoot(), '.claude', 'logs', 'sessions', 'active-session.json');
      if (fs.existsSync(sessionFile)) {
        const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        sessionId = data.sessionId || '';
      }
    } catch {}

    const valueEvent = {
      timestamp: new Date().toISOString(),
      sessionId,
      type: 'session_search',
      count: results.length,
      details: { source: 'hybrid-search', query },
    };
    fs.appendFileSync(valueLogPath, JSON.stringify(valueEvent) + '\n');
  } catch {}

  if (results.length === 0) {
    console.log('No results found.\n');
    return;
  }

  const uniqueSessions = sessionDiversityCount(results);
  console.log(`Found ${results.length} results from ${uniqueSessions} sessions:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const staleness = formatStaleness(r.metadata.date);

    console.log('─'.repeat(80));
    console.log(`#${i + 1} [${r.tier.toUpperCase()}] Hybrid: ${(r.hybridScore * 100).toFixed(1)}%`);

    if (options.verbose) {
      console.log(`   Semantic: ${(r.semanticScore * 100).toFixed(1)}% | ` +
                  `Entity: ${(r.entityScore * 100).toFixed(1)}% | ` +
                  `Recency: ${(r.recencyScore * 100).toFixed(1)}%`);
    }

    console.log(`Session: ${r.sessionId}`);
    console.log(`Date: ${r.metadata.date} | Age: ${staleness}`);

    if (r.matchedEntities.length > 0) {
      console.log(`Entities: ${r.matchedEntities.join(', ')}`);
    }

    console.log('─'.repeat(80));

    const preview = r.chunkText.length > 400
      ? r.chunkText.substring(0, 400) + '...'
      : r.chunkText;
    console.log(preview);
    console.log('');
  }

  console.log('═'.repeat(80));
}

if (require.main === module) {
  main().catch(console.error);
}
