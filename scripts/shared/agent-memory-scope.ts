/**
 * AgentMemoryScope — Lightweight 3-scope agent memory system
 *
 * Implements project/local/user scoped memory with cross-agent knowledge transfer.
 * Inspired by ruflo's AgentMemoryScope but standalone — no AgentDB dependency.
 *
 * Scopes:
 *   - project: Shared via git (team knowledge). Stored in .ai-memory/shared/
 *   - local: Git-ignored (personal workspace state). Stored in .ai-memory/local/
 *   - user: Global across workspaces. Stored in ~/.lane-memory/
 *
 * Each scope stores entries as JSON files with metadata for confidence-based transfer.
 */

import * as fs from 'fs';
import * as path from 'path';

export type MemoryScope = 'project' | 'local' | 'user';

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  scope: MemoryScope;
  category: string;
  confidence: number;
  source: string; // agent or session that created it
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  tags: string[];
}

interface ScopeConfig {
  dir: string;
  description: string;
}

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

export class AgentMemoryScope {
  private scopes: Record<MemoryScope, ScopeConfig>;

  constructor() {
    const workspaceRoot = findWorkspaceRoot();
    const homeDir = process.env.HOME || process.env.USERPROFILE || '~';

    this.scopes = {
      project: {
        dir: path.join(workspaceRoot, '.ai-memory', 'shared'),
        description: 'Team knowledge (shared via git)',
      },
      local: {
        dir: path.join(workspaceRoot, '.ai-memory', 'local'),
        description: 'Personal workspace state (gitignored)',
      },
      user: {
        dir: path.join(homeDir, '.lane-memory'),
        description: 'Global user knowledge (across all workspaces)',
      },
    };

    // Directories are created lazily on first write, not eagerly
  }

  /** Ensure a scope's directory exists (called before writes) */
  private ensureDir(scope: MemoryScope): void {
    const dir = this.scopes[scope].dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Store a memory entry in the specified scope */
  store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessed' | 'accessCount'>): MemoryEntry {
    const full: MemoryEntry = {
      ...entry,
      id: `${entry.scope}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessCount: 0,
    };

    this.ensureDir(full.scope);
    const filePath = this.entryPath(full.scope, full.key);
    fs.writeFileSync(filePath, JSON.stringify(full, null, 2));
    return full;
  }

  /** Retrieve a memory entry by key from a specific scope (read-only, no side effects) */
  retrieve(scope: MemoryScope, key: string): MemoryEntry | null {
    const filePath = this.entryPath(scope, key);
    if (!fs.existsSync(filePath)) return null;

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Retrieve and update access metadata (use when tracking access patterns matters) */
  touch(scope: MemoryScope, key: string): MemoryEntry | null {
    const entry = this.retrieve(scope, key);
    if (!entry) return null;

    entry.lastAccessed = new Date().toISOString();
    entry.accessCount++;
    this.ensureDir(scope);
    const filePath = this.entryPath(scope, key);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
    return entry;
  }

  /** Search entries across one or all scopes */
  search(query: string, options?: { scope?: MemoryScope; category?: string; minConfidence?: number }): MemoryEntry[] {
    const scopesToSearch = options?.scope ? [options.scope] : (['project', 'local', 'user'] as MemoryScope[]);
    const results: MemoryEntry[] = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    for (const scope of scopesToSearch) {
      const dir = this.scopes[scope].dir;
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const entry: MemoryEntry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

          if (options?.category && entry.category !== options.category) continue;
          if (options?.minConfidence && entry.confidence < options.minConfidence) continue;

          // Keyword matching
          const searchable = `${entry.key} ${entry.value} ${entry.tags.join(' ')}`.toLowerCase();
          const matchCount = queryWords.filter(w => searchable.includes(w)).length;
          if (matchCount > 0) {
            results.push(entry);
          }
        } catch {
          // Skip malformed files
        }
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /** List all entries in a scope */
  list(scope: MemoryScope): MemoryEntry[] {
    const dir = this.scopes[scope].dir;
    if (!fs.existsSync(dir)) return [];

    const entries: MemoryEntry[] = [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        entries.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      } catch {
        // Skip malformed
      }
    }
    return entries.sort((a, b) => new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime());
  }

  /** Transfer knowledge from one scope to another (cross-agent transfer) */
  transfer(
    fromScope: MemoryScope,
    toScope: MemoryScope,
    options?: { minConfidence?: number; category?: string },
  ): number {
    const threshold = options?.minConfidence ?? 0.8;
    const entries = this.list(fromScope);
    let transferred = 0;

    for (const entry of entries) {
      if (entry.confidence < threshold) continue;
      if (options?.category && entry.category !== options.category) continue;

      // Check if already exists in target scope
      const existing = this.retrieve(toScope, entry.key);
      if (existing) continue;

      this.store({
        key: entry.key,
        value: entry.value,
        scope: toScope,
        category: entry.category,
        confidence: entry.confidence * 0.9, // Slight confidence decay on transfer
        source: `transferred-from-${fromScope}:${entry.source}`,
        tags: [...entry.tags, 'transferred'],
      });
      transferred++;
    }

    return transferred;
  }

  /** Delete a memory entry */
  delete(scope: MemoryScope, key: string): boolean {
    const filePath = this.entryPath(scope, key);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Get stats across all scopes */
  stats(): Record<MemoryScope, { count: number; avgConfidence: number; categories: string[] }> {
    const result: Record<string, { count: number; avgConfidence: number; categories: string[] }> = {};
    for (const scope of ['project', 'local', 'user'] as MemoryScope[]) {
      const entries = this.list(scope);
      const categories = [...new Set(entries.map(e => e.category))];
      const avgConf = entries.length > 0 ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length : 0;
      result[scope] = { count: entries.length, avgConfidence: Math.round(avgConf * 100) / 100, categories };
    }
    return result as Record<MemoryScope, { count: number; avgConfidence: number; categories: string[] }>;
  }

  private entryPath(scope: MemoryScope, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
    return path.join(this.scopes[scope].dir, `${safeKey}.json`);
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const memory = new AgentMemoryScope();

  switch (command) {
    case 'stats':
      console.log(JSON.stringify(memory.stats(), null, 2));
      break;

    case 'list': {
      const scope = (args[1] || 'project') as MemoryScope;
      const entries = memory.list(scope);
      for (const e of entries) {
        console.log(`[${e.scope}/${e.category}] ${e.key}: ${e.value.slice(0, 80)}${e.value.length > 80 ? '...' : ''} (conf: ${e.confidence})`);
      }
      console.log(`\nTotal: ${entries.length} entries in ${scope} scope`);
      break;
    }

    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.error('Usage: agent-memory-scope search <query>');
        process.exit(1);
      }
      const results = memory.search(query);
      for (const e of results) {
        console.log(`[${e.scope}/${e.category}] ${e.key}: ${e.value.slice(0, 80)}`);
      }
      console.log(`\nFound: ${results.length} entries`);
      break;
    }

    case 'store': {
      if (args.length < 5) {
        console.error('Usage: agent-memory-scope store <scope> <key> <category> <value>');
        process.exit(1);
      }
      const entry = memory.store({
        scope: args[1] as MemoryScope,
        key: args[2],
        category: args[3],
        value: args.slice(4).join(' '),
        confidence: 0.8,
        source: 'cli',
        tags: [],
      });
      console.log(`Stored: ${entry.id}`);
      break;
    }

    case 'transfer': {
      if (args.length < 3) {
        console.error('Usage: agent-memory-scope transfer <from-scope> <to-scope> [min-confidence]');
        process.exit(1);
      }
      const count = memory.transfer(args[1] as MemoryScope, args[2] as MemoryScope, {
        minConfidence: args[3] ? parseFloat(args[3]) : 0.8,
      });
      console.log(`Transferred: ${count} entries from ${args[1]} to ${args[2]}`);
      break;
    }

    default:
      console.log('AgentMemoryScope — 3-scope agent memory with cross-agent transfer');
      console.log('');
      console.log('Commands:');
      console.log('  stats                                     Show memory stats across all scopes');
      console.log('  list <scope>                              List entries in scope (project|local|user)');
      console.log('  search <query>                            Search entries across all scopes');
      console.log('  store <scope> <key> <category> <value>    Store a new entry');
      console.log('  transfer <from> <to> [min-confidence]     Transfer high-confidence knowledge between scopes');
  }
}
