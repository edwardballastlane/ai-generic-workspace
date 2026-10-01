/**
 * Entity Extractor
 *
 * Extracts entities from session chunks using regex pattern matching.
 * Based on research:
 * - GraphRAG Survey (arXiv:2408.08921): Entity extraction for knowledge graphs
 * - A-Mem (arXiv:2502.12110): Autonomous attribute-based organization
 *
 * Entity Types:
 * - tools: npm packages, CLI tools, frameworks, libraries
 * - concepts: programming concepts, patterns, methodologies
 * - decisions: architectural decisions, technology choices
 * - files: file paths, directories mentioned
 * - actions: operations performed
 */

export type EntityType = 'tool' | 'concept' | 'decision' | 'file' | 'action';

export interface Entity {
  type: EntityType;
  name: string;
  context: string;  // Brief context of how it was mentioned
  confidence: number;  // 0-1 confidence score
  mentions: number;  // Number of times mentioned
}

export interface ExtractionResult {
  entities: Entity[];
  summary: string;
  topics: string[];
  extractedAt: string;
}

export class EntityExtractor {
  private cache: Map<string, ExtractionResult>;

  constructor() {
    this.cache = new Map();
  }

  /**
   * Extract entities from text using regex patterns
   */
  async extract(text: string, useCache: boolean = true): Promise<ExtractionResult> {
    // Check cache first
    const cacheKey = this.hashText(text);
    if (useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const result = this.regexExtraction(text);

    // Cache the result
    this.cache.set(cacheKey, result);

    return result;
  }

  /**
   * Deduplicate entities by name
   */
  private deduplicateEntities(entities: Entity[]): Entity[] {
    const seen = new Map<string, Entity>();

    for (const entity of entities) {
      const key = `${entity.type}:${entity.name}`;

      if (seen.has(key)) {
        // Merge by taking higher confidence and incrementing mentions
        const existing = seen.get(key)!;
        existing.confidence = Math.max(existing.confidence, entity.confidence);
        existing.mentions++;
      } else {
        seen.set(key, { ...entity });
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Simple hash for caching
   */
  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * Extraction using regex patterns (no LLM needed)
   */
  private regexExtraction(text: string): ExtractionResult {
    const entities: Entity[] = [];

    // Extract npm packages (common pattern)
    const npmPattern = /(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+([\w@/-]+)/gi;
    let match;
    while ((match = npmPattern.exec(text)) !== null) {
      entities.push({
        type: 'tool',
        name: match[1].toLowerCase(),
        context: 'npm package installation',
        confidence: 0.9,
        mentions: 1,
      });
    }

    // Extract file paths
    const filePattern = /(?:^|[\s'"(])((?:\.\/|\.\.\/|\/)?(?:[\w-]+\/)*[\w.-]+\.[a-z]{1,5})(?:[\s'")]|$)/gim;
    while ((match = filePattern.exec(text)) !== null) {
      entities.push({
        type: 'file',
        name: match[1],
        context: 'file reference',
        confidence: 0.7,
        mentions: 1,
      });
    }

    // Extract git operations
    const gitPattern = /git\s+([\w-]+)(?:\s+[\w-]+)?/gi;
    while ((match = gitPattern.exec(text)) !== null) {
      entities.push({
        type: 'action',
        name: `git ${match[1]}`,
        context: 'git operation',
        confidence: 0.85,
        mentions: 1,
      });
    }

    // Extract common tools mentioned
    const toolKeywords = [
      'docker', 'kubernetes', 'react', 'vue', 'angular', 'typescript', 'javascript',
      'python', 'rust', 'golang', 'node', 'npm', 'yarn', 'pnpm', 'webpack', 'vite',
      'postgres', 'mysql', 'mongodb', 'redis', 'supabase', 'prisma', 'drizzle',
    ];

    for (const tool of toolKeywords) {
      if (text.toLowerCase().includes(tool)) {
        entities.push({
          type: 'tool',
          name: tool,
          context: 'mentioned in conversation',
          confidence: 0.6,
          mentions: 1,
        });
      }
    }

    return {
      entities: this.deduplicateEntities(entities),
      summary: 'Extracted via regex patterns',
      topics: [],
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Extract entities from multiple chunks and merge
   */
  async extractBatch(chunks: string[]): Promise<ExtractionResult> {
    const allEntities: Entity[] = [];
    const allTopics = new Set<string>();
    const summaries: string[] = [];

    for (const chunk of chunks) {
      const result = await this.extract(chunk);
      allEntities.push(...result.entities);
      result.topics.forEach(t => allTopics.add(t));
      if (result.summary) {
        summaries.push(result.summary);
      }
    }

    // Merge and deduplicate
    const mergedEntities = this.deduplicateEntities(allEntities);

    return {
      entities: mergedEntities.sort((a, b) => b.confidence - a.confidence).slice(0, 20),
      summary: summaries[0] || '',
      topics: Array.from(allTopics).slice(0, 10),
      extractedAt: new Date().toISOString(),
    };
  }
}

// Export singleton
let defaultExtractor: EntityExtractor | null = null;

export function getDefaultExtractor(): EntityExtractor {
  if (!defaultExtractor) {
    defaultExtractor = new EntityExtractor();
  }
  return defaultExtractor;
}
