#!/usr/bin/env ts-node
/**
 * Proposal Manager: Stage, review, validate, and apply rules.
 *
 * In autonomous mode: validates via Claude CLI → saves to rules.json → git commits.
 * In propose-and-confirm mode: stages proposals for manual review.
 *
 * Rules are stored in rules.json and synced to Qdrant for semantic search.
 * CLAUDE.md is no longer modified — rules are injected contextually via hook.
 *
 * Usage:
 *   ts-node proposal-manager.ts review           # Show recent changes and pending proposals
 *   ts-node proposal-manager.ts apply             # Apply pending proposals
 *   ts-node proposal-manager.ts apply --dry-run   # Preview what would be applied
 *   ts-node proposal-manager.ts add "rule text"   # Add a rule directly
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Rule, StagedChange, Config } from './types';
import * as claude from './claude-client';
import { embed, cosineSimilarity } from '../shared/embedder';
import { categorizeRule, detectProjects } from './rule-categorizer';
import * as qdrant from './vector-client';
import { getActor, appendHistory } from './rule-history';

const WORKSPACE_ROOT = findWorkspaceRoot();
const RULES_PATH = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/rules.json');
const CONFIG_PATH = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/config.json');
const STAGED_DIR = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/staged-changes');

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

function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}. Run setup first.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function loadRules(): Rule[] {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch {
    return [];
  }
}

export function saveRules(rules: Rule[]): void {
  fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2) + '\n');
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Validate a rule using Claude CLI: check coherence, non-contradiction, specificity.
 * Returns { valid: boolean, reason: string }.
 */
export async function validateRule(ruleText: string, existingRules: Rule[]): Promise<{ valid: boolean; reason: string }> {
  const available = await claude.isClaudeAvailable();
  if (!available) {
    return { valid: false, reason: 'Claude CLI unavailable — staging instead of auto-applying' };
  }

  const existingTexts = existingRules
    .filter(r => r.status === 'active')
    .map(r => `- ${r.text}`)
    .join('\n');

  const prompt = `You are a rule validator for a developer assistant. Evaluate this proposed rule:

"${ruleText}"

Existing rules:
${existingTexts || '(none)'}

Check these criteria:
1. SPECIFIC: Is it actionable and specific? (Reject vague rules like "be careful" or "try harder")
2. NON-CONTRADICTING: Does it contradict any existing rule?
3. COHERENT: Is it well-formed and makes sense?
4. CONCISE: Is it under 50 words?

Respond with exactly one line: VALID or INVALID: <reason>`;

  try {
    const response = await claude.generate(prompt);
    const firstLine = response.trim().split('\n')[0];
    if (firstLine.toUpperCase().startsWith('VALID')) {
      return { valid: true, reason: 'Passed validation' };
    }
    const reason = firstLine.replace(/^INVALID:\s*/i, '');
    return { valid: false, reason };
  } catch {
    return { valid: false, reason: 'Validation failed — staging instead' };
  }
}

/**
 * Check if a new rule is too similar to existing rules (deduplication).
 */
export async function isDuplicate(ruleText: string, existingRules: Rule[], threshold: number): Promise<boolean> {
  try {
    const newEmbed = await embed(ruleText);
    for (const rule of existingRules.filter(r => r.status === 'active' || r.status === 'proposed')) {
      const existingEmbed = await embed(rule.text);
      const sim = cosineSimilarity(newEmbed, existingEmbed);
      if (sim > threshold) return true;
    }
    return false;
  } catch {
    // If embedding fails, do text-based check
    const normalizedNew = ruleText.toLowerCase().trim();
    return existingRules.some(r => (r.status === 'active' || r.status === 'proposed') && r.text.toLowerCase().trim() === normalizedNew);
  }
}

/**
 * No-op: Rules are no longer written to CLAUDE.md.
 * Kept for backward compatibility with callers that haven't been updated.
 * @deprecated Use inject-rules hook for contextual rule injection instead.
 */
export function writeRulesToClaudeMd(_rules: Rule[]): void {
  // No-op — rules are injected contextually via .claude/hooks/scripts/inject-rules.js
}

/**
 * Embed and upsert a single rule to Qdrant.
 */
async function upsertRuleToQdrant(rule: Rule): Promise<void> {
  try {
    const embedding = await embed(rule.text);
    await qdrant.storeRule(rule.id, embedding, {
      text: rule.text,
      status: rule.status,
      source: rule.source,
      categories: rule.categories || categorizeRule(rule.text),
      reinforcementCount: rule.reinforcementCount,
      createdAt: rule.createdAt,
    });
  } catch (err) {
    console.error(`  Failed to upsert rule to Qdrant:`, (err as Error).message);
  }
}

/**
 * Sync all active rules from rules.json to Qdrant (idempotent).
 */
export async function syncRulesToQdrant(): Promise<number> {
  const rules = loadRules();
  const activeRules = rules.filter(r => r.status === 'active');

  if (activeRules.length === 0) {
    console.log('No active rules to sync.');
    return 0;
  }

  const qdrantOk = await qdrant.isQdrantAvailable();
  if (!qdrantOk) {
    console.error('Qdrant not available — skipping rule sync.');
    return 0;
  }

  // Ensure categories are set on all rules
  let categoriesUpdated = false;
  for (const rule of activeRules) {
    if (!rule.categories || rule.categories.length === 0) {
      rule.categories = categorizeRule(rule.text);
      categoriesUpdated = true;
    }
  }
  if (categoriesUpdated) {
    saveRules(rules);
  }

  // Build embeddings and sync to Qdrant
  const rulePoints: Array<{ id: string; embedding: number[]; payload: Record<string, unknown> }> = [];

  for (const rule of activeRules) {
    try {
      const embedding = await embed(rule.text);
      rulePoints.push({
        id: rule.id,
        embedding,
        payload: {
          text: rule.text,
          status: rule.status,
          source: rule.source,
          categories: rule.categories || [],
          reinforcementCount: rule.reinforcementCount,
          createdAt: rule.createdAt,
        },
      });
    } catch (err) {
      console.error(`  Failed to embed rule ${rule.id}:`, (err as Error).message);
    }
  }

  const synced = await qdrant.syncAllRules(rulePoints);
  console.log(`Synced ${synced}/${activeRules.length} active rules to Qdrant.`);
  return synced;
}

/**
 * Run a git subcommand, retrying if another process holds the index lock.
 * The self-improve pipeline races with session-logging hooks; we only retry
 * on the lock-contention signature, not on real errors.
 */
function runGitWithLockRetry(args: string[]): void {
  const maxAttempts = 5;
  const baseDelayMs = 150;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      execFileSync('git', args, { cwd: WORKSPACE_ROOT, stdio: 'pipe' });
      return;
    } catch (err) {
      const e = err as Error & { stderr?: Buffer };
      const stderr = e.stderr ? e.stderr.toString() : '';
      const combined = `${e.message}\n${stderr}`;
      const isLockContention = combined.includes('index.lock') && combined.includes('File exists');
      if (!isLockContention || attempt === maxAttempts - 1) {
        lastErr = e;
        break;
      }
      const sleep = baseDelayMs * Math.pow(2, attempt);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep);
    }
  }
  throw lastErr;
}

/**
 * Create a git commit for a self-improvement change.
 */
function gitCommit(message: string, files: string[]): boolean {
  try {
    const staged: string[] = [];
    for (const file of files) {
      // Personal rules.json is gitignored and must stay local — only tracked
      // (shared) files get committed. Skip ignored files rather than forcing
      // them in with `add -f`, which previously re-tracked personal rules and
      // leaked them into the shared repo. Sharing happens via promote-rules.ts
      // → rules-shared.json, which the user commits manually.
      const rel = path.relative(WORKSPACE_ROOT, file);
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', rel], { cwd: WORKSPACE_ROOT, stdio: 'ignore' });
        ignored = true; // exit 0 → path is ignored
      } catch { /* exit 1 → not ignored, fall through to stage it */ }
      if (ignored) continue;
      runGitWithLockRetry(['add', file]);
      staged.push(file);
    }
    if (staged.length === 0) return true; // nothing shareable — stays local
    const subject = `chore(self-improve): ${message}`;
    const coAuthor = 'Co-Authored-By: Claude <noreply@anthropic.com>';
    runGitWithLockRetry(['commit', '-m', subject, '-m', coAuthor]);
    return true;
  } catch (err) {
    console.error('Git commit failed:', (err as Error).message);
    return false;
  }
}

/**
 * Stage a proposal for later review.
 */
function stageProposal(change: StagedChange): void {
  if (!fs.existsSync(STAGED_DIR)) {
    fs.mkdirSync(STAGED_DIR, { recursive: true });
  }
  const filePath = path.join(STAGED_DIR, `${change.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(change, null, 2));
}

/**
 * Add a new rule (validates, deduplicates, applies or stages).
 */
export async function addRule(
  ruleText: string,
  source: Rule['source'] = 'manual',
  sourceSessionIds: string[] = [],
  options?: { dryRun?: boolean }
): Promise<{ applied: boolean; reason: string }> {
  const config = loadConfig();
  const rules = loadRules();
  const activeRules = rules.filter(r => r.status === 'active');

  // Check rule cap
  if (activeRules.length >= config.maxActiveRules) {
    // Retire the least-reinforced rule
    const sorted = [...activeRules].sort((a, b) => a.reinforcementCount - b.reinforcementCount);
    const toRetire = sorted[0];
    toRetire.status = 'retired';
    appendHistory(toRetire, 'retired', `rule cap (${config.maxActiveRules}) reached`);
    console.log(`Rule cap (${config.maxActiveRules}) reached. Retiring least-reinforced: "${toRetire.text}"`);
  }

  // Deduplication check — include shared/team rules to avoid re-extracting promoted rules
  const sharedRulesPath = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/rules-shared.json');
  let allRulesForDedup = rules;
  try {
    const sharedRules: Rule[] = JSON.parse(fs.readFileSync(sharedRulesPath, 'utf8'));
    const personalIds = new Set(rules.map(r => r.id));
    const uniqueShared = sharedRules.filter(r => !personalIds.has(r.id));
    allRulesForDedup = [...rules, ...uniqueShared];
  } catch { /* shared rules file missing — dedup against personal only */ }
  const dup = await isDuplicate(ruleText, allRulesForDedup, config.deduplicationSimilarity);
  if (dup) {
    return { applied: false, reason: 'Duplicate of existing rule' };
  }

  // Validation
  const validation = await validateRule(ruleText, rules);

  const categories = categorizeRule(ruleText);
  const projects = detectProjects(ruleText);
  const author = getActor();
  const newRule: Rule & { projects?: string[] } = {
    id: generateId(),
    text: ruleText,
    source,
    status: 'active',
    reinforcementCount: 0,
    createdAt: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    sourceSessionIds,
    categories,
    author,
    history: [],
    ...(projects.length > 0 ? { projects } : {}),
  };
  appendHistory(newRule, 'created', `source=${source}`, author);

  if (options?.dryRun) {
    console.log(`[DRY RUN] Would add rule: "${ruleText}"`);
    console.log(`  Validation: ${validation.valid ? 'PASSED' : `FAILED (${validation.reason})`}`);
    console.log(`  Categories: ${categories.join(', ')}`);
    return { applied: false, reason: 'Dry run' };
  }

  if (config.approvalMode === 'autonomous' && validation.valid) {
    // Auto-apply
    appendHistory(newRule, 'activated', 'autonomous mode (validation passed)');
    rules.push(newRule);
    saveRules(rules);
    await upsertRuleToQdrant(newRule);
    const projectTag = projects.length > 0 ? `[${projects.join(',')}] ` : '';
    gitCommit(`add rule: ${projectTag}${ruleText.substring(0, 60)}`, [RULES_PATH]);
    return { applied: true, reason: 'Auto-applied (autonomous mode)' };
  } else {
    // Stage for review
    newRule.status = 'proposed';
    appendHistory(newRule, 'staged', validation.valid ? 'propose-and-confirm mode' : `validation: ${validation.reason}`);
    rules.push(newRule);
    saveRules(rules);
    stageProposal({
      id: newRule.id,
      type: 'rule',
      description: ruleText,
      content: ruleText,
      status: 'proposed',
      createdAt: newRule.createdAt,
    });
    const reason = validation.valid
      ? 'Staged (propose-and-confirm mode)'
      : `Staged (${validation.reason})`;
    return { applied: false, reason };
  }
}

/**
 * Apply all pending proposals.
 */
export async function applyPending(options?: { dryRun?: boolean }): Promise<void> {
  const rules = loadRules();
  const proposed = rules.filter(r => r.status === 'proposed');

  if (proposed.length === 0) {
    console.log('No pending proposals to apply.');
    return;
  }

  console.log(`Found ${proposed.length} pending proposal(s):\n`);

  // Dedup proposals against active rules and against each other before promoting
  const activeRules = rules.filter(r => r.status === 'active');
  const config = loadConfig();
  const threshold = config.deduplicationSimilarity;

  // Pre-embed active rules for comparison
  const activeEmbeddings: Array<{ text: string; embedding: number[] }> = [];
  for (const rule of activeRules) {
    try {
      const emb = await embed(rule.text);
      activeEmbeddings.push({ text: rule.text, embedding: emb });
    } catch { /* skip */ }
  }

  // Track embeddings of proposals we've already promoted in this run
  const promotedEmbeddings: Array<{ text: string; embedding: number[] }> = [];

  let applied = 0;
  let dedupRetired = 0;

  for (const rule of proposed) {
    console.log(`  - "${rule.text}"`);
    if (options?.dryRun) {
      console.log(`    [DRY RUN] Would activate`);
      continue;
    }

    // Check if this proposal is a duplicate of an active rule or already-promoted proposal
    let isDup = false;
    try {
      const ruleEmbed = await embed(rule.text);

      // Check against active rules
      for (const active of activeEmbeddings) {
        if (cosineSimilarity(ruleEmbed, active.embedding) > threshold) {
          isDup = true;
          console.log(`    Retired (duplicate of active rule: "${active.text.substring(0, 50)}...")`);
          break;
        }
      }

      // Check against already-promoted proposals in this run
      if (!isDup) {
        for (const promoted of promotedEmbeddings) {
          if (cosineSimilarity(ruleEmbed, promoted.embedding) > threshold) {
            isDup = true;
            console.log(`    Retired (duplicate of promoted proposal: "${promoted.text.substring(0, 50)}...")`);
            break;
          }
        }
      }

      if (isDup) {
        rule.status = 'retired';
        appendHistory(rule, 'retired', 'duplicate of existing rule');
        dedupRetired++;
        continue;
      }

      // Not a duplicate — validate and promote
      const validation = await validateRule(rule.text, rules.filter(r => r.status === 'active'));
      if (validation.valid) {
        rule.status = 'active';
        rule.categories = categorizeRule(rule.text);
        appendHistory(rule, 'activated', 'apply-pending (validation passed)');
        promotedEmbeddings.push({ text: rule.text, embedding: ruleEmbed });
        applied++;
        console.log(`    Activated`);
      } else {
        console.log(`    Rejected: ${validation.reason}`);
        rule.status = 'retired';
        appendHistory(rule, 'rejected', validation.reason);
      }
    } catch {
      // Embedding failed — fall back to text-based dedup
      const normalized = rule.text.toLowerCase().trim();
      const dupOfActive = activeRules.some(r => r.text.toLowerCase().trim() === normalized);
      const dupOfPromoted = promotedEmbeddings.some(p => p.text.toLowerCase().trim() === normalized);

      if (dupOfActive || dupOfPromoted) {
        rule.status = 'retired';
        appendHistory(rule, 'retired', 'duplicate (text-level)');
        dedupRetired++;
        console.log(`    Retired (text-level duplicate)`);
        continue;
      }

      const validation = await validateRule(rule.text, rules.filter(r => r.status === 'active'));
      if (validation.valid) {
        rule.status = 'active';
        rule.categories = categorizeRule(rule.text);
        appendHistory(rule, 'activated', 'apply-pending fallback (validation passed)');
        applied++;
        console.log(`    Activated`);
      } else {
        console.log(`    Rejected: ${validation.reason}`);
        rule.status = 'retired';
        appendHistory(rule, 'rejected', validation.reason);
      }
    }
  }

  if (dedupRetired > 0) {
    console.log(`\nRetired ${dedupRetired} duplicate proposal(s) during apply.`);
  }

  if (!options?.dryRun && (applied > 0 || dedupRetired > 0)) {
    saveRules(rules);
    gitCommit(`apply ${applied} pending rule(s), retire ${dedupRetired} duplicate(s)`, [RULES_PATH]);
    console.log(`Applied ${applied} rule(s), committed to git.`);
  }

  // Clean staged files
  if (!options?.dryRun && fs.existsSync(STAGED_DIR)) {
    for (const file of fs.readdirSync(STAGED_DIR)) {
      const filePath = path.join(STAGED_DIR, file);
      try {
        const staged: StagedChange = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (rules.some(r => r.id === staged.id && r.status !== 'proposed')) {
          fs.unlinkSync(filePath);
        }
      } catch { /* ignore */ }
    }
  }
}

/**
 * Deduplicate all proposed rules: cluster by semantic similarity, keep best per cluster,
 * and retire proposals that duplicate active rules. One-time cleanup for backlog.
 */
export async function deduplicateProposals(options?: { dryRun?: boolean }): Promise<void> {
  const rules = loadRules();
  const proposed = rules.filter(r => r.status === 'proposed');
  const active = rules.filter(r => r.status === 'active');
  const config = loadConfig();
  const threshold = config.deduplicationSimilarity;

  console.log(`Deduplicating proposals: ${proposed.length} proposed, ${active.length} active rules`);

  if (proposed.length === 0) {
    console.log('No proposed rules to deduplicate.');
    return;
  }

  // Embed all proposed and active rules
  console.log('Embedding all rules for comparison...');
  const proposedWithEmbed: Array<{ rule: Rule; embedding: number[] | null }> = [];
  for (const rule of proposed) {
    try {
      const emb = await embed(rule.text);
      proposedWithEmbed.push({ rule, embedding: emb });
    } catch {
      proposedWithEmbed.push({ rule, embedding: null });
    }
    if (proposedWithEmbed.length % 50 === 0) {
      process.stdout.write(`\r  Embedded ${proposedWithEmbed.length}/${proposed.length} proposed rules...`);
    }
  }
  console.log(`\n  Embedded ${proposedWithEmbed.length} proposed rules.`);

  const activeEmbeddings: Array<{ rule: Rule; embedding: number[] }> = [];
  for (const rule of active) {
    try {
      const emb = await embed(rule.text);
      activeEmbeddings.push({ rule, embedding: emb });
    } catch { /* skip */ }
  }
  console.log(`  Embedded ${activeEmbeddings.length} active rules.`);

  // Step 1: Retire proposals that are duplicates of active rules
  let retiredVsActive = 0;
  for (const p of proposedWithEmbed) {
    if (p.rule.status !== 'proposed') continue;
    if (!p.embedding) continue;

    for (const a of activeEmbeddings) {
      if (cosineSimilarity(p.embedding, a.embedding) > threshold) {
        if (!options?.dryRun) {
          p.rule.status = 'retired';
          appendHistory(p.rule, 'retired', 'deduplicate: matches active rule');
        }
        retiredVsActive++;
        break;
      }
    }
  }
  console.log(`\nRetired ${retiredVsActive} proposals duplicating active rules.`);

  // Step 2: Cluster remaining proposals and keep best per cluster
  const remaining = proposedWithEmbed.filter(p => p.rule.status === 'proposed' && p.embedding);
  const clustered = new Set<string>(); // rule IDs already assigned to a cluster
  let retiredVsProposed = 0;

  for (let i = 0; i < remaining.length; i++) {
    const p = remaining[i];
    if (clustered.has(p.rule.id)) continue;

    // Find all duplicates of this rule among remaining proposals
    const cluster: typeof remaining = [p];
    for (let j = i + 1; j < remaining.length; j++) {
      const q = remaining[j];
      if (clustered.has(q.rule.id)) continue;
      if (cosineSimilarity(p.embedding!, q.embedding!) > threshold) {
        cluster.push(q);
      }
    }

    if (cluster.length <= 1) continue;

    // Keep the one with highest reinforcement, then oldest as tiebreaker
    cluster.sort((a, b) => {
      const reinforceDiff = b.rule.reinforcementCount - a.rule.reinforcementCount;
      if (reinforceDiff !== 0) return reinforceDiff;
      return new Date(a.rule.createdAt).getTime() - new Date(b.rule.createdAt).getTime();
    });

    // Keep first, retire rest
    for (let k = 1; k < cluster.length; k++) {
      if (!options?.dryRun) {
        cluster[k].rule.status = 'retired';
        appendHistory(cluster[k].rule, 'retired', `deduplicate: lost to proposal ${cluster[0].rule.id}`);
      }
      clustered.add(cluster[k].rule.id);
      retiredVsProposed++;
    }
    clustered.add(cluster[0].rule.id);
  }
  console.log(`Retired ${retiredVsProposed} duplicate proposals (within-proposal clusters).`);

  // Also handle proposals where embedding failed — text-based dedup
  const noEmbed = proposedWithEmbed.filter(p => p.rule.status === 'proposed' && !p.embedding);
  const seenTexts = new Set<string>();

  // Add all active rule texts
  for (const a of active) seenTexts.add(a.text.toLowerCase().trim());
  // Add remaining embedded proposals that survived
  for (const p of proposedWithEmbed) {
    if (p.rule.status === 'proposed' && p.embedding) {
      seenTexts.add(p.rule.text.toLowerCase().trim());
    }
  }

  let retiredTextBased = 0;
  for (const p of noEmbed) {
    const normalized = p.rule.text.toLowerCase().trim();
    if (seenTexts.has(normalized)) {
      if (!options?.dryRun) {
        p.rule.status = 'retired';
        appendHistory(p.rule, 'retired', 'deduplicate: text-level duplicate');
      }
      retiredTextBased++;
    } else {
      seenTexts.add(normalized);
    }
  }
  if (retiredTextBased > 0) {
    console.log(`Retired ${retiredTextBased} proposals via text-based dedup (embedding failed).`);
  }

  const totalRetired = retiredVsActive + retiredVsProposed + retiredTextBased;
  const remainingProposed = rules.filter(r => r.status === 'proposed').length;

  console.log(`\nSummary: ${totalRetired} retired, ${remainingProposed} unique proposals remain.`);

  if (!options?.dryRun && totalRetired > 0) {
    saveRules(rules);
    gitCommit(`deduplicate proposals: retire ${totalRetired} duplicates, ${remainingProposed} remain`, [RULES_PATH]);
    console.log('Saved and committed.');
  } else if (options?.dryRun) {
    console.log('[DRY RUN] No changes saved.');
  }
}

/**
 * Show review of current state: active rules, pending proposals, recent changes.
 */
export function review(): void {
  const rules = loadRules();
  const active = rules.filter(r => r.status === 'active');
  const proposed = rules.filter(r => r.status === 'proposed');
  const retired = rules.filter(r => r.status === 'retired');

  console.log('Self-Improvement Review');
  console.log('='.repeat(50));

  console.log(`\nActive rules: ${active.length}`);
  for (const r of active) {
    const age = Math.round((Date.now() - new Date(r.createdAt).getTime()) / 86400000);
    const cats = r.categories ? ` [${r.categories.join(', ')}]` : '';
    console.log(`  [${r.id}] (reinforced: ${r.reinforcementCount}, ${age}d old)${cats} ${r.text}`);
  }

  if (proposed.length > 0) {
    console.log(`\nPending proposals: ${proposed.length}`);
    for (const r of proposed) {
      console.log(`  [${r.id}] ${r.text}`);
    }
  }

  console.log(`\nRetired rules: ${retired.length}`);

  // Check staged changes directory
  if (fs.existsSync(STAGED_DIR)) {
    const stagedFiles = fs.readdirSync(STAGED_DIR).filter(f => f.endsWith('.json'));
    if (stagedFiles.length > 0) {
      console.log(`\nStaged changes: ${stagedFiles.length}`);
      for (const file of stagedFiles) {
        try {
          const staged: StagedChange = JSON.parse(fs.readFileSync(path.join(STAGED_DIR, file), 'utf8'));
          console.log(`  [${staged.type}] ${staged.description}`);
        } catch { /* ignore */ }
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const dryRun = args.includes('--dry-run');

  switch (command) {
    case 'review':
      review();
      break;

    case 'apply':
      await applyPending({ dryRun });
      break;

    case 'add': {
      const ruleText = args.slice(1).filter(a => a !== '--dry-run').join(' ');
      if (!ruleText) {
        console.error('Usage: proposal-manager.ts add "rule text"');
        process.exit(1);
      }
      const result = await addRule(ruleText, 'manual', [], { dryRun });
      console.log(`Result: ${result.reason}`);
      break;
    }

    case 'sync':
      await syncRulesToQdrant();
      break;

    case 'deduplicate':
      await deduplicateProposals({ dryRun });
      break;

    default:
      console.log('Proposal Manager');
      console.log('');
      console.log('Usage:');
      console.log('  review              Show active rules, pending proposals');
      console.log('  apply               Apply pending proposals');
      console.log('  apply --dry-run     Preview what would be applied');
      console.log('  add "rule text"     Add a rule directly');
      console.log('  sync                Sync all active rules to Qdrant');
      console.log('  deduplicate         Deduplicate all proposed rules');
      console.log('  deduplicate --dry-run  Preview dedup without saving');
      break;
  }
}

if (require.main === module) {
  main().catch(console.error);
}
