#!/usr/bin/env ts-node
/**
 * Insight Extractor (ExpeL): Compare high/low quality session chunks
 * to extract actionable rules using Claude CLI.
 *
 * Algorithm:
 * 1. Query Qdrant for high-quality (>=7) and low-quality (<=3) chunks
 * 2. For each success/failure pair, prompt Claude to extract rules
 * 3. Deduplicate against existing rules
 * 4. Apply or stage via proposal-manager
 *
 * Usage:
 *   npm run self:extract-insights
 *   ts-node insight-extractor.ts --dry-run
 */

import * as fs from 'fs';
import * as path from 'path';
import { Config } from './types';
import * as claude from './claude-client';
import * as qdrant from './vector-client';
import { addRule } from './proposal-manager';

function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = process.cwd();
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();
const CONFIG_PATH = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/config.json');

/**
 * Advance the learning-health watermark so the session-stop / pre-push checks
 * (scripts/_lib/learning-health.js) know extraction just ran — no matter whether
 * it was triggered manually (self:maintenance), directly (self:extract-insights),
 * or automatically by the hook. Best-effort; never throws.
 */
function recordExtractionWatermark(): void {
  try {
    const statePath = path.join(WORKSPACE_ROOT, '.claude/logs/learning-state.json');
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* fresh */ }
    state.lastExtractionAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  } catch { /* never block extraction */ }
}

function loadConfig(): Config {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

interface ChunkGroup {
  highQuality: Array<{ text: string; score: number; sessionId: string }>;
  lowQuality: Array<{ text: string; score: number; sessionId: string }>;
}

/**
 * Filter out meta-observations that describe chunks rather than providing actionable guidance.
 */
function isActionableRule(text: string): boolean {
  const lowerText = text.toLowerCase();

  // Reject patterns that describe chunks rather than provide guidance
  const metaObservationPatterns = [
    /^the (first|second|high|low|good|bad) (chunk|quality)/i,
    /^it (provided|included|was|lacked|failed|succeeded)/i,
    /chunk (was|is|failed|succeeded|provided|lacked)/i,
    /was successful because/i,
    /failed (because|due to)/i,
    /which made it (successful|fail)/i,
    /leading to its (success|failure)/i,
    /^(this|that) (chunk|approach|method)/i,
  ];

  for (const pattern of metaObservationPatterns) {
    if (pattern.test(text)) {
      return false;
    }
  }

  // Prefer rules that start with imperative verbs
  const imperativeStarts = [
    'always', 'never', 'verify', 'ensure', 'include', 'document',
    'check', 'use', 'avoid', 'prefer', 'when', 'before', 'after',
    'provide', 'structure', 'organize', 'validate', 'confirm'
  ];

  const startsWithImperative = imperativeStarts.some(verb =>
    lowerText.startsWith(verb) || lowerText.startsWith(verb + ' ')
  );

  // If it doesn't start with an imperative verb, it's likely a meta-observation
  if (!startsWithImperative) {
    // Check if it at least contains actionable language
    const actionableIndicators = ['should', 'must', 'need to', 'important to'];
    const hasActionableLanguage = actionableIndicators.some(ind => lowerText.includes(ind));
    if (!hasActionableLanguage) {
      return false;
    }
  }

  return true;
}

/**
 * Fetch scored chunks from Qdrant and group by quality.
 */
async function fetchAndGroupChunks(config: Config): Promise<ChunkGroup> {
  const highQuality: ChunkGroup['highQuality'] = [];
  const lowQuality: ChunkGroup['lowQuality'] = [];

  // Fetch high-quality chunks
  const highPoints = await qdrant.scrollSessions(
    { must: [{ key: 'quality_score', range: { gte: config.qualityThresholdSuccess } }] },
    200
  );

  for (const point of highPoints) {
    const text = (point.payload.chunk_text as string) || (point.payload.text as string) || '';
    if (text.length > 50) {
      highQuality.push({
        text,
        score: point.payload.quality_score as number,
        sessionId: point.payload.session_id as string,
      });
    }
  }

  // Fetch low-quality chunks
  const lowPoints = await qdrant.scrollSessions(
    { must: [{ key: 'quality_score', range: { lte: config.qualityThresholdFailure } }] },
    200
  );

  for (const point of lowPoints) {
    const text = (point.payload.chunk_text as string) || (point.payload.text as string) || '';
    if (text.length > 50) {
      lowQuality.push({
        text,
        score: point.payload.quality_score as number,
        sessionId: point.payload.session_id as string,
      });
    }
  }

  return { highQuality, lowQuality };
}

/**
 * Extract rules by comparing high and low quality chunk pairs using Claude CLI.
 */
async function extractRulesFromPairs(
  group: ChunkGroup,
  maxPairs: number = 10
): Promise<Array<{ text: string; sessionIds: string[] }>> {
  const extracted: Array<{ text: string; sessionIds: string[] }> = [];

  // Take up to maxPairs comparisons
  const pairCount = Math.min(maxPairs, group.highQuality.length, group.lowQuality.length);

  // Build prompts for batching
  const pairs: Array<{ high: typeof group.highQuality[0]; low: typeof group.lowQuality[0] }> = [];
  for (let i = 0; i < pairCount; i++) {
    pairs.push({
      high: group.highQuality[i],
      low: group.lowQuality[i % group.lowQuality.length],
    });
  }

  // Process in batches of 3 pairs per Claude call
  const batchSize = 3;
  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);

    const prompt = `You are extracting ACTIONABLE RULES for a developer assistant. Compare these session chunk pairs and extract rules that tell the assistant WHAT TO DO.

CRITICAL REQUIREMENTS:
- Rules MUST be imperative commands (start with verbs like "Always", "Never", "Verify", "Include", "Document")
- Rules must be actionable guidance, NOT observations about the chunks
- DO NOT write "The chunk was successful because..." or "The HIGH QUALITY chunk..."
- DO NOT describe what happened - describe what TO DO
- EXACTLY ONE TRIGGER AND ONE ACTION per rule. Reject compound rules — no "X and also Y",
  no "A, B, and C" lists, no joining two distinct actions with "and". If a chunk suggests
  two behaviors, emit two separate rules (or just the single strongest one).
- Be specific and add a concrete requirement. Do NOT restate generic best practices
  ("write clean code", "test thoroughly") or vaguely broaden an obvious rule.

GOOD rule examples (single trigger → single action):
- "Always include concrete examples alongside explanatory text"
- "Verify output is complete before drawing conclusions"
- "Document command workflows with numbered steps"

BAD rule examples (DO NOT GENERATE THESE):
- "The first chunk was successful because it provided clear information" (observation, not actionable)
- "The HIGH QUALITY chunk is structured and detailed" (describes chunk, not guidance)
- "It included specific details about the queue" (starts with "It", not imperative)
- "Always source credentials from .env AND URL-encode query parameters" (compound — two actions)
- "Structure PRs with target env, architecture, no console.*, and complete JSDoc" (compound — a list of actions)

${batch.map((pair, idx) => `
=== PAIR ${idx + 1} ===
HIGH QUALITY (score ${pair.high.score}/10):
${pair.high.text.substring(0, 600)}

LOW QUALITY (score ${pair.low.score}/10):
${pair.low.text.substring(0, 600)}
`).join('\n')}

Extract 1-2 IMPERATIVE rules per pair (under 50 words each). Return ONLY the rules, one per line, starting with "- ".`;

    try {
      const response = await claude.generate(prompt);
      const lines = response.split('\n').filter(l => l.trim().startsWith('- '));

      for (const line of lines) {
        const ruleText = line.replace(/^-\s*/, '').trim();
        if (ruleText.length > 10 && ruleText.length < 200 && isActionableRule(ruleText)) {
          // Associate with session IDs from this batch
          const sessionIds = batch.flatMap(p => [p.high.sessionId, p.low.sessionId]).filter(Boolean);
          extracted.push({
            text: ruleText,
            sessionIds: [...new Set(sessionIds)],
          });
        }
      }

      process.stdout.write(`\r  Processed ${Math.min(i + batchSize, pairs.length)}/${pairs.length} pairs...`);
    } catch (err) {
      console.error(`\n  Failed to extract from batch ${i / batchSize + 1}:`, (err as Error).message);
    }
  }

  console.log('');
  return extracted;
}

export async function extractInsights(options?: { dryRun?: boolean }): Promise<number> {
  const config = loadConfig();

  console.log('Insight Extractor (ExpeL) - Claude CLI');
  console.log('='.repeat(40));

  // Check services
  const claudeOk = await claude.isClaudeAvailable();
  const qdrantOk = await qdrant.isQdrantAvailable();

  if (!claudeOk) {
    console.error('Claude CLI is not available. Cannot extract insights.');
    return 0;
  }
  if (!qdrantOk) {
    console.error('Qdrant is not available. Cannot extract insights.');
    return 0;
  }

  // Fetch and group chunks
  console.log('Fetching scored session chunks...');
  const group = await fetchAndGroupChunks(config);
  console.log(`Found ${group.highQuality.length} high-quality and ${group.lowQuality.length} low-quality chunks.`);

  if (group.highQuality.length === 0 || group.lowQuality.length === 0) {
    console.log('Need both high and low quality chunks to extract insights.');
    console.log('Run `npm run session:score` first to score session chunks.');
    return 0;
  }

  // Extract rules from pairs
  console.log('\nExtracting rules from chunk comparisons...');
  const candidates = await extractRulesFromPairs(group);
  console.log(`Extracted ${candidates.length} candidate rule(s).`);

  // Within-batch dedup: skip duplicate candidate rules before calling addRule
  const seenRules = new Set<string>();
  const uniqueCandidates = candidates.filter(c => {
    const normalized = c.text.toLowerCase().trim();
    if (seenRules.has(normalized)) return false;
    seenRules.add(normalized);
    return true;
  });

  if (uniqueCandidates.length < candidates.length) {
    console.log(`Deduplicated ${candidates.length - uniqueCandidates.length} duplicate candidate(s) within batch.`);
  }

  // Apply each unique candidate
  let applied = 0;
  for (const candidate of uniqueCandidates) {
    const result = await addRule(
      candidate.text,
      'insight-extraction',
      candidate.sessionIds,
      { dryRun: options?.dryRun }
    );
    if (result.applied) {
      applied++;
      console.log(`  ✓ Applied: "${candidate.text.substring(0, 60)}..."`);
    } else {
      console.log(`  → ${result.reason}: "${candidate.text.substring(0, 60)}..."`);
    }
  }

  console.log(`\nDone. Applied ${applied} of ${candidates.length} candidate(s).`);
  if (!options?.dryRun) recordExtractionWatermark();
  return applied;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await extractInsights({ dryRun });
}

if (require.main === module) {
  main().catch(console.error);
}
