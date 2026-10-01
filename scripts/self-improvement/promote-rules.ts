#!/usr/bin/env ts-node
/**
 * Promote Rules — Move high-value personal rules into shared team rules
 *
 * Workflow:
 *   1. Scans personal rules.json for rules with reinforcement >= threshold
 *   2. Shows candidates for review
 *   3. With --apply, copies them to rules-shared.json (git-tracked)
 *   4. Team commits and pushes rules-shared.json
 *
 * Usage:
 *   npx ts-node promote-rules.ts                    # Preview candidates
 *   npx ts-node promote-rules.ts --apply            # Apply promotion
 *   npx ts-node promote-rules.ts --threshold 20     # Custom threshold
 *   npx ts-node promote-rules.ts --all              # Show all personal rules
 */

import * as fs from 'fs';
import * as path from 'path';
import { Rule } from './types';
import { getActor, appendHistory } from './rule-history';

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

const ROOT = findWorkspaceRoot();
const PERSONAL_PATH = path.join(ROOT, 'scripts', 'self-improvement', 'rules.json');
const SHARED_PATH = path.join(ROOT, 'scripts', 'self-improvement', 'rules-shared.json');

function loadJson(filePath: string): Rule[] {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const showAll = args.includes('--all');
  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 ? parseInt(args[thresholdIdx + 1], 10) : 15;

  const personal = loadJson(PERSONAL_PATH);
  const shared = loadJson(SHARED_PATH);
  const sharedIds = new Set(shared.map(r => r.id));

  const active = personal.filter(r => r.status === 'active');
  const candidates = active
    .filter(r => !sharedIds.has(r.id))
    .filter(r => showAll || r.reinforcementCount >= threshold)
    .sort((a, b) => b.reinforcementCount - a.reinforcementCount);

  console.log('=== Rule Promotion: Personal → Shared (Team) ===\n');
  console.log(`Personal rules: ${personal.length} (${active.length} active)`);
  console.log(`Shared rules:   ${shared.length}`);
  console.log(`Threshold:      ${threshold}+ reinforcements${showAll ? ' (showing all)' : ''}`);
  console.log(`Candidates:     ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log('No rules to promote. Lower --threshold or add --all to see more.');
    return;
  }

  // Group by category
  const byCategory: Record<string, Rule[]> = {};
  for (const rule of candidates) {
    for (const cat of (rule.categories || [])) {
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(rule);
    }
  }

  for (const [cat, rules] of Object.entries(byCategory).sort()) {
    console.log(`\n--- ${cat.toUpperCase()} (${rules.length}) ---`);
    for (const r of rules) {
      const age = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000);
      console.log(`  [${r.reinforcementCount}x | ${age}d old] ${r.text.slice(0, 120)}`);
    }
  }

  if (!apply) {
    console.log(`\n→ Run with --apply to promote these ${candidates.length} rules to rules-shared.json`);
    console.log('  Then commit and push to share with the team.');
    return;
  }

  // Apply: merge candidates into shared rules and remove from personal
  const promotedIds = new Set(candidates.map(r => r.id));
  const promoter = getActor();
  const promotedAt = new Date().toISOString();
  const promoted: Rule[] = candidates.map(r => {
    const next: Rule = {
      ...r,
      source: `promoted-from-personal:${r.source}`,
      promotedBy: promoter,
      promotedAt,
    };
    appendHistory(next, 'promoted-to-team', `${candidates.length} rule(s) in this batch`, promoter);
    return next;
  });

  // Add to shared
  const merged = [...shared, ...promoted];
  fs.writeFileSync(SHARED_PATH, JSON.stringify(merged, null, 2) + '\n');

  // Remove promoted rules from personal
  const remaining = personal.filter(r => !promotedIds.has(r.id));
  fs.writeFileSync(PERSONAL_PATH, JSON.stringify(remaining, null, 2) + '\n');

  console.log(`\n✓ Promoted ${promoted.length} rules to rules-shared.json`);
  console.log(`  Promoted by: ${promoter.name}${promoter.email ? ' <' + promoter.email + '>' : ''}`);
  console.log(`  Removed ${promoted.length} promoted rules from rules.json (${remaining.length} remaining)`);
  console.log('  Next steps:');
  console.log('    git add scripts/self-improvement/rules-shared.json');
  console.log('    git commit -m "chore: promote learned rules to team shared set"');
  console.log('    git push');
}

main();
