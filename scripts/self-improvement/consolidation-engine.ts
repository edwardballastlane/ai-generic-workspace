#!/usr/bin/env ts-node
/**
 * Consolidation Engine: fight active-rule bloat.
 *
 * The maintenance cycle already extracts, reinforces, and prunes rules, and
 * proposal-manager dedups *proposals*. Nothing, however, ever merges
 * near-duplicate *active* rules or demotes contradicted ones — so the active
 * set drifts toward redundancy over time. This pass closes that gap:
 *
 *   1. MERGE (deterministic absorb): cluster active rules by embedding
 *      similarity; within each cluster keep the highest-reinforced rule and
 *      fold the rest into it (reinforcement counts, source sessions, categories
 *      and projects). Losers are retired with a `consolidated` history event.
 *      No LLM — fully reproducible, zero hallucination risk.
 *
 *   2. DEMOTE (best-effort, guarded): for pairs that are *related but not
 *      duplicate*, ask Claude whether they contradict. If so, retire the
 *      lower-reinforced rule with a `demoted` event. Skipped entirely when
 *      Claude is unavailable; bounded by config.maxContradictionChecks.
 *
 * Usage:
 *   npm run self:consolidate
 *   ts-node consolidation-engine.ts --dry-run
 */

import * as fs from 'fs';
import * as path from 'path';
import { Rule, Config } from './types';
import { embed, cosineSimilarity } from '../shared/embedder';
import { loadRules, saveRules } from './proposal-manager';
import { appendHistory } from './rule-history';
import * as qdrant from './vector-client';
import * as claude from './claude-client';

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

const WORKSPACE_ROOT = findWorkspaceRoot();
const CONFIG_PATH = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/config.json');

function loadConfig(): Config {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function unionDedup(...lists: (string[] | undefined)[]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) set.add(item);
  }
  return Array.from(set);
}

interface EmbeddedRule {
  rule: Rule;
  embedding: number[] | null;
}

/**
 * Embed every active rule once, reusing the shared embedder's process cache.
 */
async function embedActiveRules(active: Rule[]): Promise<EmbeddedRule[]> {
  const out: EmbeddedRule[] = [];
  for (const rule of active) {
    try {
      out.push({ rule, embedding: await embed(rule.text) });
    } catch {
      out.push({ rule, embedding: null });
    }
  }
  return out;
}

/**
 * Phase 1 — deterministic absorb. Mutates rules in place; returns merge count.
 */
function mergeClusters(embedded: EmbeddedRule[], threshold: number, dryRun: boolean): { merged: number; retiredIds: string[] } {
  const usable = embedded.filter(e => e.rule.status === 'active' && e.embedding);
  const clustered = new Set<string>();
  const retiredIds: string[] = [];
  let merged = 0;

  for (let i = 0; i < usable.length; i++) {
    const head = usable[i];
    if (clustered.has(head.rule.id)) continue;

    const cluster: EmbeddedRule[] = [head];
    for (let j = i + 1; j < usable.length; j++) {
      const cand = usable[j];
      if (clustered.has(cand.rule.id)) continue;
      if (cosineSimilarity(head.embedding!, cand.embedding!) > threshold) {
        cluster.push(cand);
      }
    }
    if (cluster.length <= 1) continue;

    // Winner = highest reinforcement, oldest as tiebreak (mirrors proposal dedup).
    cluster.sort((a, b) => {
      const diff = b.rule.reinforcementCount - a.rule.reinforcementCount;
      if (diff !== 0) return diff;
      return new Date(a.rule.createdAt).getTime() - new Date(b.rule.createdAt).getTime();
    });
    const winner = cluster[0].rule;
    const losers = cluster.slice(1).map(c => c.rule);

    console.log(`  Cluster of ${cluster.length} → keep [${winner.id}] "${winner.text.substring(0, 55)}..."`);

    for (const loser of losers) {
      console.log(`    absorb [${loser.id}] (${loser.reinforcementCount} reinf) "${loser.text.substring(0, 50)}..."`);
      if (!dryRun) {
        winner.reinforcementCount += loser.reinforcementCount;
        winner.sourceSessionIds = unionDedup(winner.sourceSessionIds, loser.sourceSessionIds);
        winner.categories = unionDedup(winner.categories, loser.categories);
        winner.projects = unionDedup(winner.projects, loser.projects);
        winner.consolidatedFrom = unionDedup(winner.consolidatedFrom, [loser.id]);
        loser.status = 'retired';
        loser.consolidatedInto = winner.id;
        appendHistory(loser, 'consolidated', `absorbed into ${winner.id}`);
        retiredIds.push(loser.id);
      }
      clustered.add(loser.id);
      merged++;
    }
    if (!dryRun) {
      // Most-recent reinforcement across the cluster keeps the survivor "fresh"
      // so the prune step doesn't immediately retire a freshly-merged rule.
      const newest = cluster.reduce((acc, c) =>
        new Date(c.rule.lastReinforced).getTime() > new Date(acc).getTime() ? c.rule.lastReinforced : acc,
        winner.lastReinforced);
      winner.lastReinforced = newest;
      appendHistory(winner, 'consolidated', `absorbed ${losers.length} rule(s): ${losers.map(l => l.id).join(', ')}`);
    }
    clustered.add(winner.id);
  }

  return { merged, retiredIds };
}

/**
 * Phase 2 — best-effort contradiction demotion. Returns retired ids.
 */
async function demoteContradictions(
  embedded: EmbeddedRule[],
  floor: number,
  ceil: number,
  maxChecks: number,
  dryRun: boolean,
): Promise<string[]> {
  if (!(await claude.isClaudeAvailable())) {
    console.log('  Claude unavailable — skipping contradiction detection.');
    return [];
  }

  // Build candidate pairs in the "related but not duplicate" band, strongest first.
  const usable = embedded.filter(e => e.rule.status === 'active' && e.embedding);
  const pairs: Array<{ a: Rule; b: Rule; sim: number }> = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const sim = cosineSimilarity(usable[i].embedding!, usable[j].embedding!);
      if (sim >= floor && sim < ceil) {
        pairs.push({ a: usable[i].rule, b: usable[j].rule, sim });
      }
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);

  if (pairs.length > maxChecks) {
    console.log(`  ${pairs.length} candidate pairs; checking top ${maxChecks} by similarity (cap), ${pairs.length - maxChecks} skipped.`);
  } else {
    console.log(`  ${pairs.length} candidate pair(s) to check for contradictions.`);
  }

  const retiredIds: string[] = [];
  const alreadyRetired = new Set<string>();
  const checks = pairs.slice(0, maxChecks);

  for (const { a, b } of checks) {
    if (alreadyRetired.has(a.id) || alreadyRetired.has(b.id)) continue;

    const prompt = `You compare two developer-assistant rules and decide if they CONTRADICT — i.e. following one means violating the other. Similar-but-compatible rules do NOT contradict.

Rule A: "${a.text}"
Rule B: "${b.text}"

Respond with exactly one line: CONTRADICT or COMPATIBLE`;

    let verdict = '';
    try {
      verdict = (await claude.generate(prompt)).trim().split('\n')[0].toUpperCase();
    } catch {
      continue;
    }
    if (!verdict.startsWith('CONTRADICT')) continue;

    // Demote the lower-reinforced rule (oldest as tiebreak).
    const [keep, drop] = (b.reinforcementCount > a.reinforcementCount ||
      (b.reinforcementCount === a.reinforcementCount &&
        new Date(b.createdAt).getTime() < new Date(a.createdAt).getTime()))
      ? [b, a] : [a, b];

    console.log(`  Contradiction: demote [${drop.id}] (keeps [${keep.id}])`);
    if (!dryRun) {
      drop.status = 'retired';
      appendHistory(drop, 'demoted', `contradicts ${keep.id}`);
      retiredIds.push(drop.id);
    }
    alreadyRetired.add(drop.id);
  }

  return retiredIds;
}

export async function consolidateRules(opts?: { dryRun?: boolean }): Promise<{ merged: number; demoted: number }> {
  const dryRun = opts?.dryRun ?? false;
  const config = loadConfig();
  const consolidationSimilarity = config.consolidationSimilarity ?? 0.9;
  const contradictionFloor = config.contradictionSimilarityFloor ?? 0.7;
  const maxContradictionChecks = config.maxContradictionChecks ?? 50;

  const rules = loadRules();
  const active = rules.filter(r => r.status === 'active');

  if (active.length < 2) {
    console.log('Fewer than 2 active rules — nothing to consolidate.');
    return { merged: 0, demoted: 0 };
  }

  console.log(`Consolidating ${active.length} active rule(s)${dryRun ? ' [DRY RUN]' : ''}...`);
  console.log(`  Config: merge>${consolidationSimilarity}, contradict in [${contradictionFloor}, ${consolidationSimilarity}), maxChecks=${maxContradictionChecks}`);

  const embedded = await embedActiveRules(active);
  const noEmbed = embedded.filter(e => !e.embedding).length;
  if (noEmbed > 0) console.log(`  Warning: ${noEmbed} rule(s) failed to embed and are excluded from this run.`);

  console.log('\n── Merge (deterministic absorb) ──');
  const { merged, retiredIds: mergedIds } = mergeClusters(embedded, consolidationSimilarity, dryRun);
  console.log(`  Merged ${merged} rule(s) into survivors.`);

  console.log('\n── Demote (contradiction detection) ──');
  const demotedIds = await demoteContradictions(embedded, contradictionFloor, consolidationSimilarity, maxContradictionChecks, dryRun);
  console.log(`  Demoted ${demotedIds.length} contradicted rule(s).`);

  const retiredIds = [...mergedIds, ...demotedIds];

  if (dryRun) {
    console.log(`\n[DRY RUN] Would merge ${merged} and demote ${demotedIds.length}. No changes saved.`);
    return { merged, demoted: demotedIds.length };
  }

  if (retiredIds.length === 0) {
    console.log('\nNo consolidation needed.');
    return { merged: 0, demoted: 0 };
  }

  saveRules(rules);

  // Remove retired rules from Qdrant (same best-effort pattern as pruning).
  if (await qdrant.isQdrantAvailable()) {
    try {
      await qdrant.deleteRulesBatch(retiredIds);
    } catch { /* ignore */ }
  }

  // rules.json is personal and gitignored — consolidation changes stay local
  // and are intentionally NOT committed. Rules reach the team only via
  // promote-rules.ts → rules-shared.json (committed manually). Previously this
  // force-added rules.json with `git add -f`, leaking personal rules.

  console.log(`\nConsolidated: merged ${merged}, demoted ${demotedIds.length}.`);
  return { merged, demoted: demotedIds.length };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await consolidateRules({ dryRun });
}

if (require.main === module) {
  main().catch(console.error);
}
