/**
 * Tiered Memory System
 *
 * Implements a 4-tier memory architecture based on research:
 * - MIRIX (arXiv:2507.07957v1): 6-component modular memory
 * - A-Mem (arXiv:2502.12110): Zettelkasten-style organization
 * - Mem0 (arXiv:2504.19413): Hierarchical memory with causal reasoning
 *
 * Memory Tiers:
 * 1. Working   - Current session context (ephemeral)
 * 2. Episodic  - Recent sessions with recency decay (7-30 days)
 * 3. Semantic  - Distilled key concepts and decisions
 * 4. Resource  - Reusable code patterns and snippets
 */

import * as fs from 'fs';
import * as path from 'path';
import { HNSWIndex, SearchResult } from './hnsw-index';

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

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'resource';

export interface TieredEntry {
  id: string;
  tier: MemoryTier;
  session_id: string;
  chunk_text: string;
  embedding: number[];
  metadata: {
    date: string;
    chunk_index: number;
    recency_score: number;  // 0-1, higher = more recent
    importance_score: number;  // 0-1, higher = more important
    access_count: number;
    last_accessed: string;
    tags?: string[];
    entities?: string[];
  };
}

export interface TieredSearchResult extends SearchResult {
  tier: MemoryTier;
  chunk_text: string;
  metadata: TieredEntry['metadata'];
  combined_score: number;  // Weighted combination of similarity + recency + importance
}

export interface TierConfig {
  name: MemoryTier;
  maxAge: number;  // Maximum age in days (0 = no limit)
  decayRate: number;  // Exponential decay rate for recency
  weight: number;  // Search weight for this tier
  autoPromote: boolean;  // Auto-promote to next tier
}

const TIER_CONFIGS: Record<MemoryTier, TierConfig> = {
  working: {
    name: 'working',
    maxAge: 1,        // 1 day
    decayRate: 0,     // No decay for current session
    weight: 2.0,      // Highest priority
    autoPromote: true,
  },
  episodic: {
    name: 'episodic',
    maxAge: 30,       // 30 days
    decayRate: 0.1,   // Gradual decay
    weight: 1.5,
    autoPromote: true,
  },
  semantic: {
    name: 'semantic',
    maxAge: 0,        // No expiry
    decayRate: 0.01,  // Very slow decay
    weight: 1.2,
    autoPromote: false,
  },
  resource: {
    name: 'resource',
    maxAge: 0,        // No expiry
    decayRate: 0,     // No decay
    weight: 1.0,
    autoPromote: false,
  },
};

export class TieredMemoryManager {
  private tiers: Map<MemoryTier, Map<string, TieredEntry>>;
  private hnswIndex: HNSWIndex;
  private storePath: string;
  private dirty: boolean = false;

  constructor(storePath?: string) {
    const workspaceRoot = findWorkspaceRoot();
    this.storePath = storePath || path.join(workspaceRoot, '.claude', 'vector-store', 'tiered-memory.json');

    this.tiers = new Map([
      ['working', new Map()],
      ['episodic', new Map()],
      ['semantic', new Map()],
      ['resource', new Map()],
    ]);

    this.hnswIndex = new HNSWIndex(
      path.join(path.dirname(this.storePath), 'hnsw-index.json')
    );

    this.loadStore();
  }

  private loadStore(): void {
    if (!fs.existsSync(this.storePath)) {
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));

      for (const tier of ['working', 'episodic', 'semantic', 'resource'] as MemoryTier[]) {
        const tierData = data[tier] || [];
        const tierMap = this.tiers.get(tier)!;

        for (const entry of tierData) {
          tierMap.set(entry.id, entry);
          // Also add to HNSW index if not already there
          if (!this.hnswIndex.has(entry.id)) {
            this.hnswIndex.add(entry.id, entry.embedding);
          }
        }
      }

      console.log(`Loaded tiered memory: ${this.getTotalCount()} entries across ${4} tiers`);
    } catch (error) {
      console.warn('Failed to load tiered memory, starting fresh:', error);
    }
  }

  private saveStore(): void {
    if (!this.dirty) return;

    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data: Record<string, TieredEntry[]> = {};
    for (const [tier, entries] of this.tiers) {
      data[tier] = Array.from(entries.values());
    }

    fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf8');
    this.hnswIndex.flush();
    this.dirty = false;
  }

  /**
   * Calculate recency score based on entry age
   * Uses exponential decay: score = e^(-decay_rate * age_in_days)
   */
  private calculateRecencyScore(date: string, tier: MemoryTier): number {
    const config = TIER_CONFIGS[tier];
    const ageMs = Date.now() - new Date(date).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (config.decayRate === 0) {
      return 1.0;
    }

    return Math.exp(-config.decayRate * ageDays);
  }

  /**
   * Determine initial tier for an entry based on characteristics
   */
  private determineTier(entry: Partial<TieredEntry>): MemoryTier {
    // Check if it's a resource pattern
    if (entry.metadata?.tags?.includes('pattern') ||
        entry.metadata?.tags?.includes('snippet') ||
        entry.metadata?.tags?.includes('resource')) {
      return 'resource';
    }

    // Check if it's a semantic concept
    if (entry.metadata?.tags?.includes('concept') ||
        entry.metadata?.tags?.includes('decision') ||
        entry.metadata?.importance_score && entry.metadata.importance_score > 0.8) {
      return 'semantic';
    }

    // Default to episodic for regular session content
    return 'episodic';
  }

  /**
   * Add an entry to the appropriate tier
   */
  add(entry: Omit<TieredEntry, 'tier' | 'metadata'> & { metadata?: Partial<TieredEntry['metadata']> }, forceTier?: MemoryTier): void {
    const now = new Date().toISOString();
    const tier = forceTier || this.determineTier(entry as Partial<TieredEntry>);

    const fullEntry: TieredEntry = {
      ...entry,
      tier,
      metadata: {
        date: entry.metadata?.date || now,
        chunk_index: entry.metadata?.chunk_index || 0,
        recency_score: 1.0,  // Will be calculated during search
        importance_score: entry.metadata?.importance_score || 0.5,
        access_count: 0,
        last_accessed: now,
        tags: entry.metadata?.tags || [],
        entities: entry.metadata?.entities || [],
      },
    };

    const tierMap = this.tiers.get(tier)!;
    tierMap.set(entry.id, fullEntry);

    // Add to HNSW index
    if (!this.hnswIndex.has(entry.id)) {
      this.hnswIndex.add(entry.id, entry.embedding);
    }

    this.dirty = true;
  }

  /**
   * Add multiple entries in batch
   */
  addBatch(entries: Array<Omit<TieredEntry, 'tier' | 'metadata'> & { metadata?: Partial<TieredEntry['metadata']> }>): void {
    for (const entry of entries) {
      this.add(entry);
    }
    this.saveStore();
  }

  /**
   * Search across all tiers with weighted scoring
   */
  search(
    queryEmbedding: number[],
    k: number = 10,
    options: {
      tiers?: MemoryTier[];
      minRecency?: number;
      minImportance?: number;
      tags?: string[];
    } = {}
  ): TieredSearchResult[] {
    const { tiers: searchTiers, minRecency = 0, minImportance = 0, tags } = options;
    const activeTiers = searchTiers || (['working', 'episodic', 'semantic', 'resource'] as MemoryTier[]);

    // Build filter function
    const filter = (id: string): boolean => {
      // Find entry across all tiers
      for (const tier of activeTiers) {
        const entry = this.tiers.get(tier)?.get(id);
        if (entry) {
          // Apply filters
          if (tags && tags.length > 0) {
            const entryTags = entry.metadata.tags || [];
            if (!tags.some(t => entryTags.includes(t))) {
              return false;
            }
          }
          return true;
        }
      }
      return false;
    };

    // Search HNSW index
    const hnswResults = this.hnswIndex.searchWithFilter(queryEmbedding, k * 2, filter);

    // Enrich results with tier info and calculate combined scores
    const enrichedResults: TieredSearchResult[] = [];

    for (const result of hnswResults) {
      let entry: TieredEntry | undefined;
      let tier: MemoryTier | undefined;

      // Find the entry in tiers
      for (const t of activeTiers) {
        const e = this.tiers.get(t)?.get(result.id);
        if (e) {
          entry = e;
          tier = t;
          break;
        }
      }

      if (!entry || !tier) continue;

      // Calculate recency score
      const recencyScore = this.calculateRecencyScore(entry.metadata.date, tier);

      // Apply minimum filters
      if (recencyScore < minRecency || entry.metadata.importance_score < minImportance) {
        continue;
      }

      // Calculate combined score
      const tierWeight = TIER_CONFIGS[tier].weight;
      const combinedScore =
        (result.score * 0.6) +          // Semantic similarity (60%)
        (recencyScore * 0.25) +          // Recency (25%)
        (entry.metadata.importance_score * 0.15);  // Importance (15%)

      enrichedResults.push({
        ...result,
        tier,
        chunk_text: entry.chunk_text,
        metadata: {
          ...entry.metadata,
          recency_score: recencyScore,
        },
        combined_score: combinedScore * tierWeight,
      });

      // Update access tracking
      entry.metadata.access_count++;
      entry.metadata.last_accessed = new Date().toISOString();
    }

    // Sort by combined score
    enrichedResults.sort((a, b) => b.combined_score - a.combined_score);

    this.dirty = true;

    return enrichedResults.slice(0, k);
  }

  /**
   * Promote an entry to a higher-value tier
   */
  promote(id: string, newTier: MemoryTier, reason?: string): boolean {
    // Find the entry
    let entry: TieredEntry | undefined;
    let currentTier: MemoryTier | undefined;

    for (const [tier, entries] of this.tiers) {
      if (entries.has(id)) {
        entry = entries.get(id);
        currentTier = tier;
        break;
      }
    }

    if (!entry || !currentTier) {
      return false;
    }

    // Remove from current tier
    this.tiers.get(currentTier)!.delete(id);

    // Add to new tier with updated metadata
    entry.tier = newTier;
    entry.metadata.importance_score = Math.min(1.0, entry.metadata.importance_score + 0.1);
    if (reason) {
      entry.metadata.tags = [...(entry.metadata.tags || []), `promoted:${reason}`];
    }

    this.tiers.get(newTier)!.set(id, entry);
    this.dirty = true;

    return true;
  }

  /**
   * Run maintenance: cleanup old entries, auto-promote frequently accessed
   */
  runMaintenance(): {
    expired: number;
    promoted: number;
    demoted: number;
  } {
    const now = Date.now();
    let expired = 0;
    let promoted = 0;
    let demoted = 0;

    for (const [tier, entries] of this.tiers) {
      const config = TIER_CONFIGS[tier];

      for (const [id, entry] of entries) {
        const ageMs = now - new Date(entry.metadata.date).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        // Check for expiry
        if (config.maxAge > 0 && ageDays > config.maxAge) {
          // Either promote or delete
          if (config.autoPromote && entry.metadata.access_count > 5) {
            // Promote frequently accessed entries
            const nextTier = tier === 'working' ? 'episodic' :
                             tier === 'episodic' ? 'semantic' : null;

            if (nextTier) {
              this.promote(id, nextTier, 'auto-promote');
              promoted++;
              continue;
            }
          }

          // Delete expired entries
          entries.delete(id);
          this.hnswIndex.remove(id);
          expired++;
        }
      }
    }

    this.dirty = true;
    this.saveStore();

    return { expired, promoted, demoted };
  }

  /**
   * Get statistics for all tiers
   */
  getStats(): Record<MemoryTier, {
    count: number;
    avgRecency: number;
    avgImportance: number;
    oldestDate: string;
    newestDate: string;
  }> {
    const stats: Record<string, any> = {};

    for (const [tier, entries] of this.tiers) {
      const values = Array.from(entries.values());

      if (values.length === 0) {
        stats[tier] = {
          count: 0,
          avgRecency: 0,
          avgImportance: 0,
          oldestDate: 'N/A',
          newestDate: 'N/A',
        };
        continue;
      }

      const dates = values.map(v => new Date(v.metadata.date).getTime());
      const recencyScores = values.map(v => this.calculateRecencyScore(v.metadata.date, tier as MemoryTier));

      stats[tier] = {
        count: values.length,
        avgRecency: recencyScores.reduce((a, b) => a + b, 0) / values.length,
        avgImportance: values.reduce((a, b) => a + b.metadata.importance_score, 0) / values.length,
        oldestDate: new Date(Math.min(...dates)).toISOString(),
        newestDate: new Date(Math.max(...dates)).toISOString(),
      };
    }

    return stats as Record<MemoryTier, any>;
  }

  /**
   * Get total count across all tiers
   */
  getTotalCount(): number {
    let total = 0;
    for (const entries of this.tiers.values()) {
      total += entries.size;
    }
    return total;
  }

  /**
   * Check if a session has already been added
   */
  hasSession(sessionId: string): boolean {
    for (const entries of this.tiers.values()) {
      for (const entry of entries.values()) {
        if (entry.session_id === sessionId) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Flush changes to disk
   */
  flush(): void {
    this.saveStore();
  }
}

// Export singleton for easy use
let defaultManager: TieredMemoryManager | null = null;

export function getDefaultTieredMemory(): TieredMemoryManager {
  if (!defaultManager) {
    defaultManager = new TieredMemoryManager();
  }
  return defaultManager;
}
