/**
 * Knowledge Linker
 *
 * Builds relationships between sessions based on shared entities.
 * Based on research:
 * - KG²RAG (arXiv:2502.06864): KG-guided chunk expansion
 * - A-Mem (arXiv:2502.12110): Zettelkasten-style connections
 *
 * Relationship Types:
 * - shared_tool: Sessions that use the same tool
 * - shared_concept: Sessions discussing same concept
 * - shared_file: Sessions referencing same files
 * - temporal: Sessions in close time proximity
 * - continuation: Sessions that continue previous work
 */

import * as fs from 'fs';
import * as path from 'path';
import { Entity, EntityType } from './entity-extractor';

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

export type RelationType =
  | 'shared_tool'
  | 'shared_concept'
  | 'shared_file'
  | 'shared_decision'
  | 'temporal'
  | 'continuation';

export interface EntityNode {
  id: string;
  type: EntityType;
  name: string;
  sessions: string[];  // Session IDs that reference this entity
  contexts: string[];  // Contexts from each mention
  totalMentions: number;
  firstSeen: string;
  lastSeen: string;
}

export interface Relationship {
  id: string;
  type: RelationType;
  sourceSession: string;
  targetSession: string;
  sharedEntities: string[];  // Entity names that connect them
  weight: number;  // 0-1 strength of relationship
  createdAt: string;
}

export interface KnowledgeGraph {
  entities: Record<string, EntityNode>;
  relationships: Relationship[];
  metadata: {
    totalEntities: number;
    totalRelationships: number;
    lastUpdated: string;
  };
}

export class KnowledgeLinker {
  private graph: KnowledgeGraph;
  private graphPath: string;
  private dirty: boolean = false;

  constructor(graphPath?: string) {
    const workspaceRoot = findWorkspaceRoot();
    this.graphPath = graphPath || path.join(workspaceRoot, '.claude', 'knowledge-graph', 'graph.json');

    this.graph = this.loadGraph();
  }

  private loadGraph(): KnowledgeGraph {
    if (fs.existsSync(this.graphPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.graphPath, 'utf8'));
      } catch (error) {
        console.warn('Failed to load knowledge graph, starting fresh:', error);
      }
    }

    return {
      entities: {},
      relationships: [],
      metadata: {
        totalEntities: 0,
        totalRelationships: 0,
        lastUpdated: new Date().toISOString(),
      },
    };
  }

  private saveGraph(): void {
    if (!this.dirty) return;

    const dir = path.dirname(this.graphPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.graph.metadata.totalEntities = Object.keys(this.graph.entities).length;
    this.graph.metadata.totalRelationships = this.graph.relationships.length;
    this.graph.metadata.lastUpdated = new Date().toISOString();

    fs.writeFileSync(this.graphPath, JSON.stringify(this.graph, null, 2), 'utf8');
    this.dirty = false;
  }

  /**
   * Generate entity key for deduplication
   */
  private entityKey(type: EntityType, name: string): string {
    return `${type}:${name.toLowerCase().trim()}`;
  }

  /**
   * Add entities from a session to the graph
   */
  addSessionEntities(sessionId: string, entities: Entity[], sessionDate?: string): void {
    const now = sessionDate || new Date().toISOString();

    for (const entity of entities) {
      const key = this.entityKey(entity.type, entity.name);

      if (this.graph.entities[key]) {
        // Update existing entity
        const node = this.graph.entities[key];
        if (!node.sessions.includes(sessionId)) {
          node.sessions.push(sessionId);
        }
        if (entity.context && !node.contexts.includes(entity.context)) {
          node.contexts.push(entity.context);
        }
        node.totalMentions += entity.mentions;
        node.lastSeen = now;
      } else {
        // Create new entity node
        this.graph.entities[key] = {
          id: key,
          type: entity.type,
          name: entity.name,
          sessions: [sessionId],
          contexts: entity.context ? [entity.context] : [],
          totalMentions: entity.mentions,
          firstSeen: now,
          lastSeen: now,
        };
      }
    }

    this.dirty = true;
  }

  /**
   * Build relationships between sessions based on shared entities
   */
  buildRelationships(sessionId: string): Relationship[] {
    const newRelationships: Relationship[] = [];

    // Find all entities that reference this session
    const sessionEntities: EntityNode[] = [];
    for (const entity of Object.values(this.graph.entities)) {
      if (entity.sessions.includes(sessionId)) {
        sessionEntities.push(entity);
      }
    }

    // Group by entity type for relationship typing
    const entityGroups: Record<EntityType, EntityNode[]> = {
      tool: [],
      concept: [],
      decision: [],
      file: [],
      action: [],
    };

    for (const entity of sessionEntities) {
      entityGroups[entity.type].push(entity);
    }

    // Find other sessions that share entities
    const relatedSessions = new Map<string, {
      sharedEntities: string[];
      types: Set<RelationType>;
      weight: number;
    }>();

    for (const entity of sessionEntities) {
      for (const otherSession of entity.sessions) {
        if (otherSession === sessionId) continue;

        if (!relatedSessions.has(otherSession)) {
          relatedSessions.set(otherSession, {
            sharedEntities: [],
            types: new Set(),
            weight: 0,
          });
        }

        const rel = relatedSessions.get(otherSession)!;
        rel.sharedEntities.push(entity.name);

        // Determine relationship type based on entity type
        const relType = this.entityTypeToRelationType(entity.type);
        rel.types.add(relType);

        // Weight based on entity importance
        rel.weight += this.calculateEntityWeight(entity);
      }
    }

    // Create relationships
    for (const [otherSession, data] of relatedSessions) {
      // Normalize weight
      const normalizedWeight = Math.min(1, data.weight / 10);

      // Skip weak relationships
      if (normalizedWeight < 0.1) continue;

      // Choose primary relationship type
      const primaryType = this.choosePrimaryRelationType(data.types);

      // Check if relationship already exists
      const existingRel = this.graph.relationships.find(
        r => (r.sourceSession === sessionId && r.targetSession === otherSession) ||
             (r.sourceSession === otherSession && r.targetSession === sessionId)
      );

      if (existingRel) {
        // Update existing relationship
        existingRel.sharedEntities = [...new Set([...existingRel.sharedEntities, ...data.sharedEntities])];
        existingRel.weight = Math.max(existingRel.weight, normalizedWeight);
      } else {
        // Create new relationship
        const relationship: Relationship = {
          id: `rel-${sessionId.substring(0, 8)}-${otherSession.substring(0, 8)}`,
          type: primaryType,
          sourceSession: sessionId,
          targetSession: otherSession,
          sharedEntities: [...new Set(data.sharedEntities)],
          weight: normalizedWeight,
          createdAt: new Date().toISOString(),
        };

        this.graph.relationships.push(relationship);
        newRelationships.push(relationship);
      }
    }

    this.dirty = true;
    this.saveGraph();

    return newRelationships;
  }

  /**
   * Map entity type to relationship type
   */
  private entityTypeToRelationType(type: EntityType): RelationType {
    const mapping: Record<EntityType, RelationType> = {
      tool: 'shared_tool',
      concept: 'shared_concept',
      file: 'shared_file',
      decision: 'shared_decision',
      action: 'shared_tool',  // Actions often relate to tools
    };
    return mapping[type];
  }

  /**
   * Choose primary relationship type when multiple apply
   */
  private choosePrimaryRelationType(types: Set<RelationType>): RelationType {
    // Priority order
    const priority: RelationType[] = [
      'shared_concept',
      'shared_decision',
      'shared_file',
      'shared_tool',
      'temporal',
      'continuation',
    ];

    for (const type of priority) {
      if (types.has(type)) {
        return type;
      }
    }

    return 'shared_concept';
  }

  /**
   * Calculate entity weight for relationship strength
   */
  private calculateEntityWeight(entity: EntityNode): number {
    let weight = 1;

    // More sessions = more important
    weight += Math.log(entity.sessions.length) * 0.5;

    // More mentions = more important
    weight += Math.log(entity.totalMentions) * 0.3;

    // Type-based weights
    const typeWeights: Record<EntityType, number> = {
      decision: 2.0,   // Decisions are high-value connections
      concept: 1.5,    // Concepts indicate related work
      file: 1.0,       // Files indicate same project
      tool: 0.8,       // Tools are common, less specific
      action: 0.5,     // Actions are very generic
    };

    weight *= typeWeights[entity.type];

    return weight;
  }

  /**
   * Find related sessions for a given session
   */
  findRelatedSessions(sessionId: string, limit: number = 10): Array<{
    sessionId: string;
    relationship: Relationship;
  }> {
    const related = this.graph.relationships
      .filter(r => r.sourceSession === sessionId || r.targetSession === sessionId)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map(r => ({
        sessionId: r.sourceSession === sessionId ? r.targetSession : r.sourceSession,
        relationship: r,
      }));

    return related;
  }

  /**
   * Find sessions by entity
   */
  findSessionsByEntity(entityName: string, entityType?: EntityType): string[] {
    const searchKey = entityType
      ? this.entityKey(entityType, entityName)
      : null;

    // Search through all entities
    for (const [key, entity] of Object.entries(this.graph.entities)) {
      if (searchKey && key === searchKey) {
        return entity.sessions;
      }
      if (!searchKey && entity.name.toLowerCase() === entityName.toLowerCase()) {
        return entity.sessions;
      }
    }

    return [];
  }

  /**
   * Get most connected entities (hubs)
   */
  getTopEntities(limit: number = 10, type?: EntityType): EntityNode[] {
    let entities = Object.values(this.graph.entities);

    if (type) {
      entities = entities.filter(e => e.type === type);
    }

    return entities
      .sort((a, b) => b.sessions.length - a.sessions.length)
      .slice(0, limit);
  }

  /**
   * Get graph statistics
   */
  getStats(): {
    totalEntities: number;
    totalRelationships: number;
    entitiesByType: Record<EntityType, number>;
    avgSessionsPerEntity: number;
    lastUpdated: string;
  } {
    const entitiesByType: Record<EntityType, number> = {
      tool: 0,
      concept: 0,
      decision: 0,
      file: 0,
      action: 0,
    };

    let totalSessions = 0;

    for (const entity of Object.values(this.graph.entities)) {
      entitiesByType[entity.type]++;
      totalSessions += entity.sessions.length;
    }

    const entityCount = Object.keys(this.graph.entities).length;

    return {
      totalEntities: entityCount,
      totalRelationships: this.graph.relationships.length,
      entitiesByType,
      avgSessionsPerEntity: entityCount > 0 ? totalSessions / entityCount : 0,
      lastUpdated: this.graph.metadata.lastUpdated,
    };
  }

  /**
   * Flush changes to disk
   */
  flush(): void {
    this.saveGraph();
  }
}

// Export singleton
let defaultLinker: KnowledgeLinker | null = null;

export function getDefaultLinker(): KnowledgeLinker {
  if (!defaultLinker) {
    defaultLinker = new KnowledgeLinker();
  }
  return defaultLinker;
}
