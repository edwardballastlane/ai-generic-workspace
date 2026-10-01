#!/usr/bin/env ts-node
/**
 * Seed Qdrant — Index team rules into a new developer's Qdrant instance
 *
 * Reads rules-shared.json (git-tracked team rules), generates embeddings,
 * and upserts them into the local Qdrant 'rules' collection. This gives
 * new team members semantic search over the team's learned rules.
 *
 * Usage:
 *   npm run qdrant:seed                    # Seed team rules only
 *   npm run qdrant:seed -- --include-personal  # Seed team + personal rules
 *   npm run qdrant:seed -- --status        # Check Qdrant status
 *
 * Prerequisites:
 *   docker compose up -d                   # Qdrant must be running
 */

import * as fs from 'fs';
import * as path from 'path';
import { embed } from '../shared/embedder';
import { syncAllRules, isQdrantAvailable, getRuleStats } from './qdrant-client';

interface Rule {
  id: string;
  text: string;
  source: string;
  status: string;
  reinforcementCount: number;
  createdAt: string;
  lastReinforced: string;
  sourceSessionIds: string[];
  categories?: string[];
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

function loadRules(filePath: string): Rule[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Rule[];
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const includePersonal = args.includes('--include-personal');
  const statusOnly = args.includes('--status');

  const root = findWorkspaceRoot();
  const sharedPath = path.join(root, 'scripts', 'self-improvement', 'rules-shared.json');
  const personalPath = path.join(root, 'scripts', 'self-improvement', 'rules.json');

  // Check Qdrant
  console.log('Checking Qdrant...');
  const available = await isQdrantAvailable();
  if (!available) {
    console.error('Qdrant is not running. Start it with: docker compose up -d');
    process.exit(1);
  }

  const stats = await getRuleStats();
  console.log(`Qdrant rules collection: ${stats.count} vectors\n`);

  if (statusOnly) {
    return;
  }

  // Load rules
  const shared = loadRules(sharedPath).filter(r => r.status === 'active');
  console.log(`Team rules (rules-shared.json): ${shared.length} active`);

  let allRules = shared;

  if (includePersonal) {
    const sharedIds = new Set(shared.map(r => r.id));
    const personal = loadRules(personalPath)
      .filter(r => r.status === 'active' && !sharedIds.has(r.id));
    console.log(`Personal rules (rules.json): ${personal.length} active (deduplicated)`);
    allRules = [...shared, ...personal];
  }

  if (allRules.length === 0) {
    console.log('No rules to seed.');
    return;
  }

  // Generate embeddings and sync
  console.log(`\nGenerating embeddings for ${allRules.length} rules...`);

  const rulesWithEmbeddings: Array<{ id: string; embedding: number[]; payload: Record<string, unknown> }> = [];
  let processed = 0;

  for (const rule of allRules) {
    const embedding = await embed(rule.text);
    rulesWithEmbeddings.push({
      id: rule.id,
      embedding,
      payload: {
        text: rule.text,
        source: rule.source,
        status: rule.status,
        reinforcementCount: rule.reinforcementCount,
        categories: rule.categories || [],
        createdAt: rule.createdAt,
      },
    });
    processed++;
    if (processed % 10 === 0) {
      process.stdout.write(`  ${processed}/${allRules.length}\r`);
    }
  }

  console.log(`  ${processed}/${allRules.length} embeddings generated`);
  console.log('Syncing to Qdrant...');

  const synced = await syncAllRules(rulesWithEmbeddings);
  console.log(`\nDone! Synced ${synced} rules to Qdrant.`);

  const newStats = await getRuleStats();
  console.log(`Qdrant rules collection now has ${newStats.count} vectors.`);
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
