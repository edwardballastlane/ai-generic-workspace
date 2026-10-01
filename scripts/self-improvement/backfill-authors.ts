#!/usr/bin/env ts-node
/**
 * Backfill `author` (and `promotedBy` + `promotedAt`) on rules that predate
 * the audit-trail feature by walking git history for the line that introduces
 * each rule's id.
 *
 *   author      — first commit (anywhere) that introduced the id
 *   promotedBy  — first commit that introduced the id specifically into
 *                 rules-shared.json (only applies to team rules)
 *
 * Usage:
 *   npx ts-node scripts/self-improvement/backfill-authors.ts            # dry run
 *   npx ts-node scripts/self-improvement/backfill-authors.ts --apply    # write
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Rule, RuleActor } from './types';
import { appendHistory } from './rule-history';

function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const ROOT = findWorkspaceRoot();
const PERSONAL = path.join(ROOT, 'scripts/self-improvement/rules.json');
const SHARED = path.join(ROOT, 'scripts/self-improvement/rules-shared.json');

interface FirstCommit {
  sha: string;
  ts: string;
  name: string;
  email: string;
}

function firstIntroducingCommit(ruleId: string, files: string[]): FirstCommit | null {
  // -S filters commits that change the number of occurrences of the string.
  // --reverse + head -1 gives the earliest such commit.
  // --diff-filter=A is not used because rule entries are added inside an
  // existing file, so the COMMIT is M not A — the LINE is added, which is
  // what -S detects.
  try {
    const args = [
      'log',
      '--format=%H|%aI|%an|%ae',
      '-S', `"id": "${ruleId}"`,
      '--reverse',
      '--',
      ...files,
    ];
    const out = execFileSync('git', args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split('\n').find(l => l.trim().length > 0);
    if (!first) return null;
    const [sha, ts, name, email] = first.split('|');
    return { sha, ts, name, email };
  } catch {
    return null;
  }
}

function toActor(c: FirstCommit): RuleActor {
  return { name: c.name || 'unknown', email: c.email || '' };
}

function loadRules(file: string): Rule[] {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function backfillFile(file: string, isShared: boolean): { rules: Rule[]; updated: number } {
  const rules = loadRules(file);
  let updated = 0;
  for (const rule of rules) {
    const needAuthor = !rule.author;
    const needPromotion = isShared && (!rule.promotedBy || !rule.promotedAt);
    if (!needAuthor && !needPromotion) continue;

    if (needAuthor) {
      const c = firstIntroducingCommit(rule.id, [PERSONAL, SHARED]);
      if (c) {
        rule.author = toActor(c);
        appendHistory(
          rule,
          'created',
          `backfilled from commit ${c.sha.slice(0, 8)}`,
          rule.author,
          c.ts,
        );
        updated++;
      }
    }

    if (needPromotion) {
      const c = firstIntroducingCommit(rule.id, [SHARED]);
      if (c) {
        rule.promotedBy = toActor(c);
        rule.promotedAt = c.ts;
        appendHistory(
          rule,
          'promoted-to-team',
          `backfilled from commit ${c.sha.slice(0, 8)}`,
          rule.promotedBy,
          c.ts,
        );
        updated++;
      }
    }
  }
  return { rules, updated };
}

function main() {
  const apply = process.argv.includes('--apply');
  console.log(`=== Backfill rule authorship ===`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const personalResult = backfillFile(PERSONAL, false);
  console.log(`Personal rules.json:    ${personalResult.rules.length} total, ${personalResult.updated} backfilled`);

  const sharedResult = backfillFile(SHARED, true);
  console.log(`Shared rules-shared.json: ${sharedResult.rules.length} total, ${sharedResult.updated} backfilled\n`);

  if (!apply) {
    console.log(`→ Run with --apply to persist. Will write ${personalResult.updated + sharedResult.updated} backfill events to disk.`);
    return;
  }

  if (personalResult.updated > 0) {
    fs.writeFileSync(PERSONAL, JSON.stringify(personalResult.rules, null, 2) + '\n');
    console.log(`✓ Wrote ${personalResult.updated} backfills to rules.json`);
  }
  if (sharedResult.updated > 0) {
    fs.writeFileSync(SHARED, JSON.stringify(sharedResult.rules, null, 2) + '\n');
    console.log(`✓ Wrote ${sharedResult.updated} backfills to rules-shared.json`);
  }
  console.log('\nNext: review with `git diff scripts/self-improvement/rules*.json` then commit.');
}

main();
