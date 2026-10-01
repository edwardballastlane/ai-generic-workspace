#!/usr/bin/env ts-node
/**
 * Maintenance: Orchestrate all self-improvement tasks.
 *
 * Runs:
 * 1. Insight extraction (ExpeL)
 * 1.5. Reflection generation (Reflexion) — new sessions only, via reflection-state
 * 2. Reinforcement tracking
 * 2.5. Consolidation (merge near-duplicate active rules, demote contradicted)
 * 3. Pruning stale rules
 * 4. Stats summary
 *
 * Usage:
 *   npm run self:maintenance
 *   ts-node maintenance.ts --dry-run
 */

import { extractInsights } from './insight-extractor';
import { trackReinforcement } from './reinforcement-tracker';
import { pruneStaleRules, showStats } from './reinforcement-tracker';
import { consolidateRules } from './consolidation-engine';
import { generateReflectionsFromSessions } from './reflection-generator';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  console.log('╔══════════════════════════════════════╗');
  console.log('║   Self-Improvement Maintenance Run   ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Step 1: Extract insights
  console.log('─── Step 1: Insight Extraction ───\n');
  try {
    await extractInsights({ dryRun });
  } catch (err) {
    console.error('Insight extraction failed:', (err as Error).message);
  }

  // Step 1.5: Generate reflections from new sessions (Reflexion).
  // Skipped on --dry-run since it stores to Qdrant + the file-backed metrics
  // file and proposes prevention rules. Incremental: reflection-state.json makes
  // it process only sessions not seen before, and it no-ops if Claude/Qdrant are
  // unavailable. Runs before consolidation so new prevention rules get deduped.
  if (!dryRun) {
    console.log('\n─── Step 1.5: Reflection Generation ───\n');
    try {
      const stored = await generateReflectionsFromSessions();
      console.log(`Generated ${stored} reflection(s).`);
    } catch (err) {
      console.error('Reflection generation failed:', (err as Error).message);
    }
  } else {
    console.log('\n─── Step 1.5: Reflection Generation (skipped: --dry-run) ───');
  }

  // Step 2: Track reinforcement
  console.log('\n─── Step 2: Reinforcement Tracking ───\n');
  try {
    await trackReinforcement();
  } catch (err) {
    console.error('Reinforcement tracking failed:', (err as Error).message);
  }

  // Step 2.5: Consolidate near-duplicate / contradicted active rules
  console.log('\n─── Step 2.5: Consolidation ───\n');
  try {
    const result = await consolidateRules({ dryRun });
    console.log(`Merged: ${result.merged}, Demoted: ${result.demoted}`);
  } catch (err) {
    console.error('Consolidation failed:', (err as Error).message);
  }

  // Step 3: Prune stale rules
  console.log('\n─── Step 3: Pruning ───\n');
  try {
    const result = await pruneStaleRules();
    console.log(`Pruned: ${result.pruned}, Flagged: ${result.flagged}`);
  } catch (err) {
    console.error('Pruning failed:', (err as Error).message);
  }

  // Step 4: Stats
  console.log('\n─── Summary ───\n');
  try {
    await showStats();
  } catch (err) {
    console.error('Stats failed:', (err as Error).message);
  }

  console.log('\nMaintenance complete.');
}

main().catch(console.error);
