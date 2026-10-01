/**
 * Recency Decay Functions
 *
 * Implements various decay strategies for memory recency scoring.
 * Based on research from:
 * - Mem0 (arXiv:2504.19413): Hierarchical memory with temporal reasoning
 * - MIRIX (arXiv:2507.07957v1): Episodic memory with decay
 *
 * Decay Types:
 * 1. Exponential - Standard memory decay: score = e^(-λt)
 * 2. Power law - Long-tail preservation: score = 1 / (1 + t)^α
 * 3. Stepped - Tier-based decay with discrete levels
 * 4. Access-boosted - Decay modified by access frequency
 */

export type DecayType = 'exponential' | 'power-law' | 'stepped' | 'access-boosted';

export interface DecayConfig {
  type: DecayType;
  halfLife: number;     // Days until score reaches 0.5 (for exponential)
  alpha: number;        // Power law exponent
  minScore: number;     // Minimum score floor (0-1)
  accessBoost: number;  // Boost per access (0-1)
  maxBoost: number;     // Maximum boost from access (0-1)
}

const DEFAULT_CONFIG: DecayConfig = {
  type: 'exponential',
  halfLife: 7,      // 7 days to reach 50%
  alpha: 1.5,       // Power law exponent
  minScore: 0.1,    // Never go below 10%
  accessBoost: 0.05,  // 5% boost per access
  maxBoost: 0.3,    // Max 30% boost
};

/**
 * Exponential decay: score = e^(-λt) where λ = ln(2)/halfLife
 * Most commonly used for memory models
 */
export function exponentialDecay(
  ageDays: number,
  halfLife: number = 7,
  minScore: number = 0.1
): number {
  const lambda = Math.log(2) / halfLife;
  const score = Math.exp(-lambda * ageDays);
  return Math.max(minScore, score);
}

/**
 * Power law decay: score = 1 / (1 + t)^α
 * Preserves long-tail better than exponential
 */
export function powerLawDecay(
  ageDays: number,
  alpha: number = 1.5,
  minScore: number = 0.1
): number {
  const score = 1 / Math.pow(1 + ageDays, alpha);
  return Math.max(minScore, score);
}

/**
 * Stepped decay: Discrete decay levels based on age
 * Good for tier-based memory systems
 */
export function steppedDecay(
  ageDays: number,
  steps: Array<{ maxAge: number; score: number }> = [
    { maxAge: 1, score: 1.0 },     // Today: 100%
    { maxAge: 3, score: 0.9 },     // 1-3 days: 90%
    { maxAge: 7, score: 0.75 },    // 4-7 days: 75%
    { maxAge: 14, score: 0.5 },    // 8-14 days: 50%
    { maxAge: 30, score: 0.3 },    // 15-30 days: 30%
    { maxAge: Infinity, score: 0.1 }, // 30+ days: 10%
  ]
): number {
  for (const step of steps) {
    if (ageDays <= step.maxAge) {
      return step.score;
    }
  }
  return 0.1;
}

/**
 * Access-boosted decay: Base decay modified by access frequency
 * Frequently accessed items decay slower
 */
export function accessBoostedDecay(
  ageDays: number,
  accessCount: number,
  config: Partial<DecayConfig> = {}
): number {
  const { halfLife, accessBoost, maxBoost, minScore } = { ...DEFAULT_CONFIG, ...config };

  // Calculate base exponential decay
  const baseScore = exponentialDecay(ageDays, halfLife, 0);

  // Calculate access boost (logarithmic to prevent exploitation)
  const boost = Math.min(maxBoost, Math.log(1 + accessCount) * accessBoost);

  // Combine and clamp
  return Math.max(minScore, Math.min(1.0, baseScore + boost));
}

/**
 * Combined decay calculator supporting all strategies
 */
export class DecayCalculator {
  private config: DecayConfig;

  constructor(config: Partial<DecayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate decay score for an item
   */
  calculate(
    date: string | Date,
    accessCount: number = 0
  ): number {
    const ageMs = Date.now() - new Date(date).getTime();
    const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));

    switch (this.config.type) {
      case 'exponential':
        return exponentialDecay(ageDays, this.config.halfLife, this.config.minScore);

      case 'power-law':
        return powerLawDecay(ageDays, this.config.alpha, this.config.minScore);

      case 'stepped':
        return steppedDecay(ageDays);

      case 'access-boosted':
        return accessBoostedDecay(ageDays, accessCount, this.config);

      default:
        return exponentialDecay(ageDays, this.config.halfLife, this.config.minScore);
    }
  }

  /**
   * Calculate time until score drops below threshold
   */
  timeToThreshold(threshold: number = 0.5): number {
    if (this.config.type !== 'exponential') {
      throw new Error('timeToThreshold only supported for exponential decay');
    }

    const lambda = Math.log(2) / this.config.halfLife;
    return -Math.log(threshold) / lambda;
  }

  /**
   * Get optimal maintenance schedule based on decay config
   * Returns recommended interval in days
   */
  getMaintenanceInterval(): number {
    switch (this.config.type) {
      case 'exponential':
        // Run maintenance when oldest items reach minScore
        return this.timeToThreshold(this.config.minScore * 2);

      case 'power-law':
        // Power law decays slower, less frequent maintenance
        return 30;

      case 'stepped':
        // Based on largest step interval
        return 7;

      case 'access-boosted':
        // More frequent to update access counts
        return 3;

      default:
        return 7;
    }
  }
}

// Preset calculators for different use cases
export const PRESETS = {
  // Fast decay for working memory
  working: new DecayCalculator({
    type: 'exponential',
    halfLife: 1,
    minScore: 0,
  }),

  // Standard decay for episodic memory
  episodic: new DecayCalculator({
    type: 'access-boosted',
    halfLife: 7,
    accessBoost: 0.05,
    maxBoost: 0.3,
    minScore: 0.1,
  }),

  // Slow decay for semantic memory
  semantic: new DecayCalculator({
    type: 'power-law',
    alpha: 0.5,  // Very slow decay
    minScore: 0.3,
  }),

  // No decay for resources
  resource: new DecayCalculator({
    type: 'stepped',
  }),
};

/**
 * Calculate combined relevance score
 * Combines semantic similarity, recency, importance, and access patterns
 */
export function calculateCombinedScore(
  semanticScore: number,
  recencyScore: number,
  importanceScore: number,
  accessCount: number = 0,
  weights: {
    semantic: number;
    recency: number;
    importance: number;
    access: number;
  } = {
    semantic: 0.5,
    recency: 0.25,
    importance: 0.15,
    access: 0.1,
  }
): number {
  // Normalize access count to 0-1 scale
  const normalizedAccess = Math.min(1, Math.log(1 + accessCount) / Math.log(100));

  const combined =
    (semanticScore * weights.semantic) +
    (recencyScore * weights.recency) +
    (importanceScore * weights.importance) +
    (normalizedAccess * weights.access);

  return Math.max(0, Math.min(1, combined));
}

/**
 * Determine if an item should be promoted based on access patterns
 */
export function shouldPromote(
  accessCount: number,
  recencyScore: number,
  tier: 'working' | 'episodic' | 'semantic' | 'resource'
): boolean {
  // Thresholds for promotion
  const thresholds: Record<string, { minAccess: number; minRecency: number }> = {
    working: { minAccess: 3, minRecency: 0.3 },
    episodic: { minAccess: 10, minRecency: 0.2 },
    semantic: { minAccess: 25, minRecency: 0.1 },
    resource: { minAccess: Infinity, minRecency: 0 },  // Never promote from resource
  };

  const threshold = thresholds[tier];
  return accessCount >= threshold.minAccess && recencyScore <= threshold.minRecency;
}
