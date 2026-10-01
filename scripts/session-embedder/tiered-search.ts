#!/usr/bin/env ts-node
/**
 * Enhanced Tiered Search
 *
 * Searches across all memory tiers with weighted scoring based on:
 * - Semantic similarity (embedding distance)
 * - Recency (configurable decay)
 * - Importance (auto-calculated + manual)
 * - Access patterns (frequently accessed items rank higher)
 *
 * Usage:
 *   npm run tiered-search "your query"
 *   npm run tiered-search "your query" --tier episodic
 *   npm run tiered-search "your query" --recent 7
 *   npm run tiered-search "your query" --tags docker,kubernetes
 */

import * as fs from 'fs';
import * as path from 'path';
import { embed } from '../shared/embedder';
import { createSessionVectorStore } from './vector-store-factory';
import { formatStaleness, deduplicateBySession, sessionDiversityCount } from './result-enhancer';

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

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'resource';

export interface TieredSearchResult {
  id: string;
  score: number;
  tier: MemoryTier;
  chunk_text: string;
  metadata: {
    date: string;
    chunk_index: number;
    recency_score: number;
    access_count: number;
  };
  combined_score: number;
}

interface SearchOptions {
  tiers?: MemoryTier[];
  topK: number;
  minRecency?: number;
  minImportance?: number;
  tags?: string[];
  verbose: boolean;
}

function formatTier(tier: MemoryTier): string {
  const colors: Record<MemoryTier, string> = {
    working: '\x1b[33m',   // Yellow
    episodic: '\x1b[36m',  // Cyan
    semantic: '\x1b[35m',  // Magenta
    resource: '\x1b[32m',  // Green
  };
  const reset = '\x1b[0m';
  return `${colors[tier]}[${tier.toUpperCase()}]${reset}`;
}

function formatScore(score: number): string {
  const percentage = (score * 100).toFixed(1);
  if (score >= 0.8) return `\x1b[32m${percentage}%\x1b[0m`;  // Green
  if (score >= 0.6) return `\x1b[33m${percentage}%\x1b[0m`;  // Yellow
  return `\x1b[31m${percentage}%\x1b[0m`;  // Red
}

function logTieredSearch(query: string, resultsCount: number, topScore: number, topSessionId: string, durationMs: number) {
  try {
    const logDir = path.join(findWorkspaceRoot(), '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'search-log.jsonl');
    const entry = {
      timestamp: new Date().toISOString(),
      source: 'tiered-search',
      query,
      resultsCount,
      topScore,
      topSessionId,
      durationMs,
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {}

  // Also log value event
  logValueEvent(query, resultsCount);
}

function logValueEvent(query: string, resultsCount: number) {
  try {
    const logDir = path.join(findWorkspaceRoot(), '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'value-events.jsonl');

    let sessionId = '';
    try {
      const sessionFile = path.join(findWorkspaceRoot(), '.claude', 'logs', 'sessions', 'active-session.json');
      if (fs.existsSync(sessionFile)) {
        const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        sessionId = data.sessionId || '';
      }
    } catch {}

    const event = {
      timestamp: new Date().toISOString(),
      sessionId,
      type: 'session_search',
      count: resultsCount,
      details: { source: 'tiered-search', query },
    };
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  } catch {}
}

async function tieredSearch(query: string, options: SearchOptions): Promise<void> {
  const searchStart = Date.now();
  console.log(`\n🔍 Searching for: "${query}"\n`);

  const vectorStore = createSessionVectorStore();

  // Generate query embedding
  const queryEmbedding = await embed(query);

  // Search vector store (returns more results than needed for tier filtering)
  const qdrantResults = await vectorStore.search(queryEmbedding, options.topK * 3);

  // Enrich results with chunk text and tier information
  const enrichedResults: TieredSearchResult[] = qdrantResults.map(result => {
    const sessionId = result.session_id.split('-chunk-')[0];
    const chunkIndex = result.metadata.chunk_index;
    const chunkText = loadChunkFromSession(sessionId, chunkIndex);

    // Determine tier based on date recency
    const ageMs = Date.now() - new Date(result.metadata.date).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    let tier: MemoryTier = 'episodic';
    if (ageDays <= 1) {
      tier = 'working';
    } else if (ageDays > 30) {
      tier = 'semantic';
    }

    // Calculate recency score (exponential decay)
    const recencyScore = Math.exp(-0.1 * ageDays);

    return {
      id: result.id,
      score: result.score,
      tier,
      chunk_text: chunkText,
      metadata: {
        date: result.metadata.date,
        chunk_index: chunkIndex,
        recency_score: recencyScore,
        access_count: 0,
      },
      combined_score: (result.score * 0.6) + (recencyScore * 0.4),
    };
  });

  // Filter by tiers if specified
  let filteredResults = enrichedResults;
  if (options.tiers && options.tiers.length > 0) {
    filteredResults = enrichedResults.filter(r => options.tiers!.includes(r.tier));
  }

  // Filter by recency if specified
  if (options.minRecency !== undefined) {
    const minRecency = options.minRecency;
    filteredResults = filteredResults.filter(r => r.metadata.recency_score >= minRecency);
  }

  // Sort by combined score, deduplicate by session for diversity
  filteredResults.sort((a, b) => b.combined_score - a.combined_score);

  // Deduplicate by session (ensures diverse results across sessions)
  const results = deduplicateBySession(filteredResults, options.topK);

  logTieredSearch(
    query,
    results.length,
    results.length > 0 ? results[0].combined_score : 0,
    results.length > 0 ? results[0].id.split('-chunk-')[0] : '',
    Date.now() - searchStart,
  );

  if (results.length === 0) {
    console.log('No results found.\n');

    // Show tier breakdown of all enriched results
    const tierCounts: Record<MemoryTier, number> = {
      working: 0,
      episodic: 0,
      semantic: 0,
      resource: 0,
    };

    for (const result of enrichedResults) {
      tierCounts[result.tier]++;
    }

    console.log('📊 Tier Statistics:');
    for (const [tier, count] of Object.entries(tierCounts)) {
      console.log(`   ${tier}: ${count} entries`);
    }
    return;
  }

  const uniqueSessions = sessionDiversityCount(results);
  console.log(`Found ${results.length} results from ${uniqueSessions} sessions:\n`);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sessionId = result.id.split('-chunk-')[0];
    const staleness = formatStaleness(result.metadata.date);

    console.log('─'.repeat(80));
    console.log(
      `#${i + 1} ${formatTier(result.tier)} ` +
      `Combined: ${formatScore(result.combined_score)} ` +
      `Semantic: ${formatScore(result.score)} ` +
      `Recency: ${formatScore(result.metadata.recency_score)}`
    );
    console.log(`Session: ${sessionId}`);
    console.log(`Date: ${result.metadata.date} | Age: ${staleness}`);

    console.log('─'.repeat(80));

    // Show chunk preview
    const maxPreview = options.verbose ? 1000 : 400;
    const preview = result.chunk_text.length > maxPreview
      ? result.chunk_text.substring(0, maxPreview) + '...'
      : result.chunk_text;

    console.log(preview);
    console.log('');
  }

  // Show summary
  console.log('═'.repeat(80));
  console.log('📊 Search Summary:');

  const tierCounts: Record<MemoryTier, number> = {
    working: 0,
    episodic: 0,
    semantic: 0,
    resource: 0,
  };

  for (const result of results) {
    tierCounts[result.tier]++;
  }

  for (const [tier, count] of Object.entries(tierCounts)) {
    if (count > 0) {
      console.log(`   ${tier}: ${count} results`);
    }
  }

  const avgScore = results.reduce((sum, r) => sum + r.combined_score, 0) / results.length;
  console.log(`   Average score: ${formatScore(avgScore)}`);
  console.log('═'.repeat(80));
}

function parseArgs(args: string[]): { query: string; options: SearchOptions } {
  const options: SearchOptions = {
    topK: 5,
    verbose: false,
  };

  let query = '';
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--tier' || arg === '-t') {
      const tierArg = args[++i];
      if (tierArg) {
        options.tiers = tierArg.split(',') as MemoryTier[];
      }
    } else if (arg === '--top' || arg === '-k') {
      options.topK = parseInt(args[++i], 10) || 5;
    } else if (arg === '--recent' || arg === '-r') {
      const days = parseInt(args[++i], 10) || 7;
      // Convert days to minimum recency score
      // Using exponential decay with 7-day half-life
      options.minRecency = Math.exp(-Math.log(2) / 7 * days);
    } else if (arg === '--tags') {
      options.tags = args[++i]?.split(',') || [];
    } else if (arg === '--min-importance') {
      options.minImportance = parseFloat(args[++i]) || 0;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (!arg.startsWith('-')) {
      query = arg;
    }

    i++;
  }

  return { query, options };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Tiered Session Search
=====================

Search across memory tiers with weighted scoring.

Usage:
  npm run tiered-search "your query"
  npm run tiered-search "your query" [options]

Options:
  --tier, -t <tiers>     Comma-separated tiers to search (working,episodic,semantic,resource)
  --top, -k <n>          Number of results to return (default: 5)
  --recent, -r <days>    Only include results from last N days
  --tags <tags>          Comma-separated tags to filter by
  --min-importance <n>   Minimum importance score (0-1)
  --verbose, -v          Show full result content
  --help, -h             Show this help

Examples:
  npm run tiered-search "how to implement authentication"
  npm run tiered-search "database schema" --tier semantic,resource
  npm run tiered-search "react hooks" --recent 7 --tags typescript
  npm run tiered-search "debugging docker" -k 10 -v
`);
    return;
  }

  const { query, options } = parseArgs(args);

  if (!query) {
    console.error('Error: Please provide a search query');
    process.exit(1);
  }

  try {
    await tieredSearch(query, options);
  } catch (error) {
    console.error('Search error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { tieredSearch, SearchOptions };
