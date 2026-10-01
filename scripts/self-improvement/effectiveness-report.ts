#!/usr/bin/env ts-node
/**
 * Rule Effectiveness Report
 *
 * Correlates rule firing data (effectiveness.json) with rule metadata
 * to identify which rules are most/least valuable.
 *
 * Usage:
 *   npx ts-node effectiveness-report.ts           # Full report
 *   npx ts-node effectiveness-report.ts --json     # Machine-readable output
 */

import * as fs from 'fs';
import * as path from 'path';

interface Rule {
  id: string;
  text: string;
  status: string;
  reinforcementCount: number;
  categories?: string[];
}

interface EffectivenessEntry {
  fires: number;
  lastFired: string;
  sessions: string[];
  projects: string[];
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

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function main() {
  const root = findWorkspaceRoot();
  const dir = path.join(root, 'scripts', 'self-improvement');
  const jsonMode = process.argv.includes('--json');

  const sharedRules = loadJson<Rule[]>(path.join(dir, 'rules-shared.json'), []);
  const personalRules = loadJson<Rule[]>(path.join(dir, 'rules.json'), []);
  const sharedIds = new Set(sharedRules.map(r => r.id));
  const allRules = [...sharedRules, ...personalRules.filter(r => !sharedIds.has(r.id))];
  const activeRules = allRules.filter(r => r.status === 'active');

  const effectiveness = loadJson<Record<string, EffectivenessEntry>>(
    path.join(dir, 'effectiveness.json'), {}
  );

  // Build scored list
  const scored = activeRules.map(rule => {
    const eff = effectiveness[rule.id] || { fires: 0, lastFired: '', sessions: [], projects: [] };
    const isTeam = sharedIds.has(rule.id);
    return {
      id: rule.id,
      text: rule.text,
      categories: rule.categories || [],
      scope: isTeam ? 'team' : 'personal',
      reinforcements: rule.reinforcementCount,
      fires: eff.fires,
      lastFired: eff.lastFired || 'never',
      projects: eff.projects,
      // Effectiveness score: fires * reinforcements gives a combined signal
      effectivenessScore: eff.fires * Math.log2(rule.reinforcementCount + 1),
    };
  });

  scored.sort((a, b) => b.effectivenessScore - a.effectivenessScore);

  if (jsonMode) {
    console.log(JSON.stringify(scored, null, 2));
    return;
  }

  // Report
  const totalFires = Object.values(effectiveness).reduce((sum, e) => sum + e.fires, 0);
  const rulesWithFires = scored.filter(s => s.fires > 0);
  const neverFired = scored.filter(s => s.fires === 0);

  console.log('=== Rule Effectiveness Report ===\n');
  console.log(`Active rules:     ${activeRules.length} (${sharedRules.filter(r => r.status === 'active').length} team, ${activeRules.length - sharedRules.filter(r => r.status === 'active').length} personal)`);
  console.log(`Total fires:      ${totalFires}`);
  console.log(`Rules that fired: ${rulesWithFires.length}`);
  console.log(`Never fired:      ${neverFired.length}`);

  // Top performers
  console.log('\n--- TOP 10 MOST EFFECTIVE ---');
  for (const s of scored.slice(0, 10)) {
    const proj = s.projects.length > 0 ? ` [${s.projects.join(',')}]` : '';
    console.log(`  [${s.fires} fires | ${s.reinforcements}x reinforced | ${s.scope}]${proj}`);
    console.log(`    ${s.text.slice(0, 110)}`);
  }

  // Cross-project rules (fire across multiple projects = high value)
  const crossProject = scored.filter(s => s.projects.length >= 2);
  if (crossProject.length > 0) {
    console.log(`\n--- CROSS-PROJECT RULES (${crossProject.length}) ---`);
    for (const s of crossProject.slice(0, 5)) {
      console.log(`  [${s.projects.join(', ')}] ${s.text.slice(0, 100)}`);
    }
  }

  // Never fired (candidates for pruning)
  if (neverFired.length > 0) {
    console.log(`\n--- NEVER FIRED (${neverFired.length} rules) ---`);
    console.log('  These rules have never matched a prompt. Consider reviewing:');
    for (const s of neverFired.slice(0, 5)) {
      console.log(`  [${s.scope}] ${s.text.slice(0, 100)}`);
    }
    if (neverFired.length > 5) {
      console.log(`  ... and ${neverFired.length - 5} more`);
    }
  }

  // By category effectiveness
  console.log('\n--- EFFECTIVENESS BY CATEGORY ---');
  const catStats: Record<string, { fires: number; rules: number }> = {};
  for (const s of scored) {
    for (const cat of s.categories) {
      if (!catStats[cat]) catStats[cat] = { fires: 0, rules: 0 };
      catStats[cat].fires += s.fires;
      catStats[cat].rules++;
    }
  }
  for (const [cat, stats] of Object.entries(catStats).sort((a, b) => b[1].fires - a[1].fires)) {
    const avg = stats.rules > 0 ? (stats.fires / stats.rules).toFixed(1) : '0';
    console.log(`  ${cat.padEnd(15)} ${String(stats.fires).padStart(4)} fires across ${stats.rules} rules (avg: ${avg}/rule)`);
  }
}

main();
