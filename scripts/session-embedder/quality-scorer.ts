#!/usr/bin/env ts-node
/**
 * Quality Scorer: Score session chunks using Claude CLI.
 *
 * Scores each chunk 0-10 on usefulness/quality and stores the score
 * as metadata in Qdrant. Uses Claude CLI for fast, parallel scoring.
 *
 * Based on MAPPA (arXiv 2601.23228): per-action quality signals are
 * far more useful than outcome-only evaluation.
 *
 * Usage:
 *   npm run session:score              # Score all unscored chunks
 *   npm run session:score -- --rescore # Re-score everything
 *   npm run session:score -- --stats   # Show scoring statistics
 *   npm run session:score -- --pending # Mark unscored as pending (for exit)
 *   npm run session:score -- --session <id> # Score specific session only
 */

import { execSync, spawn } from 'child_process';
import { QDRANT_URL, qdrantHeaders } from '../shared/qdrant';

const COLLECTION_NAME = 'session-embeddings';
const BATCH_SIZE = 25; // Chunks per Claude CLI call
const MAX_CONCURRENT = 3; // Parallel Claude CLI calls

interface QdrantPoint {
  id: number | string;
  payload: Record<string, unknown>;
}

interface ScoringResult {
  id: string | number;
  score: number;
}

// Tiered heuristic scoring — only sends likely-high-quality chunks to LLM.
//
// Tier 1 (score 1):  Clear noise — empty, binary, encoded content
// Tier 2 (score 2):  Errors/stacktraces — may have minor debug value
// Tier 3 (score 3):  Routine operations — git status, file listings, basic commands
// Tier 4 (score 4):  Default — normal session content, not obviously valuable
// Tier null (LLM):   Likely valuable — contains signals of insights, solutions, decisions
function preFilterScore(chunkText: string): number | null {
  if (!chunkText || chunkText.length < 20) return 1;

  const text = chunkText.toLowerCase();

  // --- Tier 1: Clear noise (score 1) ---
  const longUnbrokenStrings = chunkText.match(/[A-Za-z0-9+/=]{100,}/g);
  if (longUnbrokenStrings && longUnbrokenStrings.some(s => s.length > 200)) return 1;
  if ((chunkText.match(/[0-9a-f]{32,}/gi) || []).length > 3) return 1;

  // --- Tier 2: Error output (score 2) ---
  if (text.includes('at object.<anonymous>') && text.includes('at module._compile')) return 2;
  if ((text.match(/at \w+\.\w+ \(/g) || []).length > 8) return 2;
  if (text.includes('npm err!') || (text.includes('errno') && text.includes('syscall'))) return 2;
  if (chunkText.startsWith('{') && chunkText.endsWith('}') &&
      (text.match(/"[^"]+"\s*:/g) || []).length > 30) return 2;

  // --- Check for high-quality signals BEFORE assigning default ---
  // Only send chunks to LLM that have STRONG evidence of being valuable.
  // Require either a strong signal phrase, or 2+ weak signals together.
  const strongSignals = [
    // Explicit problem-solving narratives
    /the (?:issue|problem|bug|root cause) (?:was|is|turned out)/,
    /(?:fixed|resolved|solved) (?:by|with|using|the)/,
    /(?:figured out|turns out|realized|discovered) (?:that|the|why|how)/,
    // Architecture & design decisions with explanation
    /(?:decided|chose|opted) (?:to|for) .{10,}/,
    /design (?:decision|pattern|trade.?off)/,
    // Learning & insights
    /(?:lesson|takeaway|key insight|important thing)/,
    /(?:best practice|anti.?pattern|pitfall|gotcha)/,
    // Explanations of why/how something works
    /(?:this works because|the reason (?:is|was)|here's (?:how|why))/,
  ];

  const weakSignals = [
    /\b(root cause|workaround|breaking change)\b/,
    /\b(refactor|migrate|redesign)\b/,
    /\b(optimization|performance (?:issue|improvement|fix))\b/,
    /\b(security (?:issue|fix|vulnerability))\b/,
    /\b(schema (?:change|migration|design))\b/,
    /\b(algorithm|architecture)\b/,
  ];

  if (strongSignals.some(pattern => pattern.test(text))) return null; // Send to LLM

  const weakMatchCount = weakSignals.filter(pattern => pattern.test(text)).length;
  if (weakMatchCount >= 2) return null; // Multiple weak signals = likely valuable

  // --- Tier 3: Routine operations (score 3) ---
  if (chunkText.length < 150 && (
    text.includes('git status') || text.includes('git add') || text.includes('git commit') ||
    text.includes('npm install') || text.includes('npm run') ||
    text.includes('cd ') || text.startsWith('ls ') || text.startsWith('$ ')
  )) return 3;
  if ((text.match(/\.(ts|js|json|md|tsx|jsx)\n/g) || []).length > 10 &&
      !text.includes('function') && !text.includes('class')) return 3;
  if (text.includes('diff --git') && text.includes('index ') &&
      !text.includes('function') && !text.includes('class') && !text.includes('const ')) return 3;

  // --- Tier 4: Default — normal content, not obviously valuable (score 4) ---
  return 4;
}

async function getPointsToScore(options: {
  rescore?: boolean;
  sessionId?: string;
  pendingOnly?: boolean;
}): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | null = null;
  const limit = 100;

  while (true) {
    const body: Record<string, unknown> = { limit, with_payload: true };
    if (offset !== null) body.offset = offset;

    // Build filter
    const mustConditions: unknown[] = [];
    const mustNotConditions: unknown[] = [];

    if (options.sessionId) {
      mustConditions.push({ key: 'session_id', match: { value: options.sessionId } });
    }

    if (options.pendingOnly) {
      mustConditions.push({ key: 'pending_score', match: { value: true } });
    } else if (!options.rescore) {
      mustNotConditions.push({
        key: 'quality_score',
        match: { any: [0,1,2,3,4,5,6,7,8,9,10] }
      });
    }

    if (mustConditions.length > 0 || mustNotConditions.length > 0) {
      body.filter = {};
      if (mustConditions.length > 0) (body.filter as Record<string, unknown>).must = mustConditions;
      if (mustNotConditions.length > 0) (body.filter as Record<string, unknown>).must_not = mustNotConditions;
    }

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Failed to scroll points: ${response.statusText}`);

    const data = await response.json() as { result: { points: QdrantPoint[]; next_page_offset?: string | number } };
    points.push(...data.result.points);

    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }

  return points;
}

async function updatePointScores(updates: Array<{ id: string | number; score: number; pending?: boolean }>): Promise<void> {
  // Update each point individually (scores differ per point)
  for (const update of updates) {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/payload`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        points: [update.id],
        payload: {
          quality_score: update.score,
          pending_score: update.pending ?? false,
        },
      }),
    });

    if (!response.ok) throw new Error(`Failed to update score for ${update.id}: ${response.statusText}`);
  }
}

async function bulkUpdateScoresByGroup(
  items: Array<{ id: string | number; score: number }>,
  batchSize = 500,
): Promise<void> {
  // Group by score so we can batch all IDs with the same score in one request
  const byScore = new Map<number, Array<string | number>>();
  for (const item of items) {
    const ids = byScore.get(item.score) || [];
    ids.push(item.id);
    byScore.set(item.score, ids);
  }

  const scores = Array.from(byScore.keys());
  for (const score of scores) {
    const ids = byScore.get(score)!;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/payload`, {
        method: 'POST',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          points: batch,
          payload: {
            quality_score: score,
            pending_score: false,
          },
        }),
      });

      if (!response.ok) throw new Error(`Failed to bulk update scores: ${response.statusText}`);
    }
  }
}

async function markAsPending(points: QdrantPoint[]): Promise<void> {
  const ids = points.map(p => p.id);

  // Batch in chunks of 100
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/payload`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        points: batch,
        payload: { pending_score: true },
      }),
    });

    if (!response.ok) throw new Error(`Failed to mark as pending: ${response.statusText}`);
  }
}

async function scoreBatchWithClaude(chunks: Array<{ id: string | number; text: string }>): Promise<ScoringResult[]> {
  // Use index-based IDs for simpler parsing, map back to real IDs after
  const prompt = `Score each chunk 0-10 for usefulness as a development reference.

Scoring guide:
- 0-2: Noise, errors, failed attempts with no learning
- 3-4: Basic context, routine operations
- 5-6: Useful pattern or solution
- 7-8: Reusable solution, important decision, key insight
- 9-10: Significant architecture, novel solution, critical learning

Return ONLY a JSON array of scores in the SAME ORDER as the chunks.
Example for 3 chunks: [7, 3, 5]

Chunks to score:
${chunks.map((c, i) => `[${i}]\n${c.text.substring(0, 500)}\n---`).join('\n')}

JSON array of scores:`;

  return new Promise((resolve) => {
    try {
      // Use spawn with stdin to avoid command line length limits
      const child = spawn('claude', ['--output-format', 'json', '--max-turns', '1', '-p', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code !== 0 || !stdout) {
          console.error(`  Batch scoring error: exit code ${code}`);
          resolve(chunks.map(c => ({ id: c.id, score: 5 })));
          return;
        }

        try {
          // Parse the Claude CLI JSON response
          // Format: { "result": "...", "content": [...], ... } or plain text
          let rawText = stdout;

          // Try to extract text from JSON wrapper
          try {
            const parsed = JSON.parse(stdout);
            // Claude CLI wraps response in { result: "..." } or { content: [...] }
            if (typeof parsed.result === 'string') {
              rawText = parsed.result;
            } else if (typeof parsed.content === 'string') {
              rawText = parsed.content;
            } else if (Array.isArray(parsed.result)) {
              rawText = JSON.stringify(parsed.result);
            } else if (Array.isArray(parsed.content)) {
              // content may be array of content blocks
              rawText = parsed.content
                .map((b: { text?: string }) => b.text || '')
                .join('');
            } else if (Array.isArray(parsed)) {
              rawText = JSON.stringify(parsed);
            }
          } catch {
            // stdout wasn't valid JSON — use as raw text
          }

          // Extract JSON array of scores from the text
          let scoreArray: number[];
          const arrayMatch = rawText.match(/\[[\d\s,]+\]/);
          if (arrayMatch) {
            scoreArray = JSON.parse(arrayMatch[0]);
          } else {
            throw new Error('No JSON array in response');
          }

          // Map scores back to chunk IDs by index
          const results: ScoringResult[] = chunks.map((chunk, index) => ({
            id: chunk.id,
            score: Math.min(10, Math.max(0, Math.round(scoreArray[index] ?? 5))),
          }));

          resolve(results);
        } catch (parseError) {
          console.error(`  Batch scoring parse error: ${parseError instanceof Error ? parseError.message : 'unknown'}`);
          resolve(chunks.map(c => ({ id: c.id, score: 5 })));
        }
      });

      child.on('error', (error) => {
        console.error(`  Batch scoring spawn error: ${error.message}`);
        resolve(chunks.map(c => ({ id: c.id, score: 5 })));
      });

      // Write prompt to stdin and close
      child.stdin.write(prompt);
      child.stdin.end();

    } catch (error) {
      console.error(`  Batch scoring error: ${error instanceof Error ? error.message : 'unknown'}`);
      resolve(chunks.map(c => ({ id: c.id, score: 5 })));
    }
  });
}

async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const promise = processor(item).then(result => {
      results.push(result);
    });
    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove completed promises
      for (let i = executing.length - 1; i >= 0; i--) {
        // Check if promise is settled by racing with immediate resolve
        const settled = await Promise.race([
          executing[i].then(() => true),
          Promise.resolve(false)
        ]);
        if (settled) executing.splice(i, 1);
      }
    }
  }

  await Promise.all(executing);
  return results;
}

async function showStats(): Promise<void> {
  let allPoints: QdrantPoint[] = [];
  let offset: string | number | null = null;

  while (true) {
    const body: Record<string, unknown> = { limit: 1000, with_payload: true };
    if (offset !== null) body.offset = offset;

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

    const data = await response.json() as { result: { points: QdrantPoint[]; next_page_offset?: string | number } };
    allPoints.push(...data.result.points);

    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }

  let scored = 0;
  let unscored = 0;
  let pending = 0;
  const distribution: Record<number, number> = {};

  for (const point of allPoints) {
    const score = point.payload?.quality_score as number | undefined;
    const isPending = point.payload?.pending_score as boolean | undefined;

    if (isPending) pending++;

    if (score !== undefined && score !== null) {
      scored++;
      distribution[score] = (distribution[score] || 0) + 1;
    } else {
      unscored++;
    }
  }

  console.log(`Quality Scoring Statistics`);
  console.log(`${'='.repeat(40)}`);
  console.log(`Total points: ${allPoints.length}`);
  console.log(`Scored: ${scored} | Unscored: ${unscored} | Pending: ${pending}`);
  console.log(`\nScore Distribution:`);

  for (let i = 0; i <= 10; i++) {
    const count = distribution[i] || 0;
    const bar = '#'.repeat(Math.round(count / Math.max(1, scored) * 50));
    console.log(`  ${i.toString().padStart(2)}: ${count.toString().padStart(5)} ${bar}`);
  }

  if (scored > 0) {
    const totalScore = Object.entries(distribution).reduce(
      (sum, [score, count]) => sum + parseInt(score) * count, 0
    );
    console.log(`\nAverage score: ${(totalScore / scored).toFixed(1)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--stats')) {
    await showStats();
    return;
  }

  const rescore = args.includes('--rescore');
  const pendingOnly = args.includes('--pending-only');
  const markPending = args.includes('--pending');
  const sessionIdIdx = args.indexOf('--session');
  const sessionId = sessionIdIdx >= 0 ? args[sessionIdIdx + 1] : undefined;

  console.log(`Quality Scorer (Claude CLI)${rescore ? ' [RESCORE]' : ''}${pendingOnly ? ' [PENDING ONLY]' : ''}`);
  console.log(`${'='.repeat(40)}`);

  const points = await getPointsToScore({ rescore, sessionId, pendingOnly });
  console.log(`Found ${points.length} chunks to process.\n`);

  if (points.length === 0) {
    console.log('All chunks already scored. Use --rescore to re-score.');
    return;
  }

  // If marking as pending (for fast exit), just mark and return
  if (markPending) {
    console.log('Marking chunks as pending for later scoring...');
    await markAsPending(points);
    console.log(`Marked ${points.length} chunks as pending.`);
    return;
  }

  // Phase 1: Pre-filter with heuristics
  console.log('Phase 1: Pre-filtering with heuristics...');
  const preFiltered: Array<{ id: string | number; score: number }> = [];
  const needsLLM: QdrantPoint[] = [];

  for (const point of points) {
    const chunkText = (point.payload.chunk_text as string) || '';
    const heuristicScore = preFilterScore(chunkText);

    if (heuristicScore !== null) {
      preFiltered.push({ id: point.id, score: heuristicScore });
    } else {
      needsLLM.push(point);
    }
  }

  console.log(`  Pre-filtered: ${preFiltered.length} chunks`);
  console.log(`  Needs LLM: ${needsLLM.length} chunks\n`);

  // Update pre-filtered scores in bulk
  if (preFiltered.length > 0) {
    await bulkUpdateScoresByGroup(preFiltered);
  }

  // Phase 2: Batch scoring with Claude CLI
  if (needsLLM.length > 0) {
    console.log('Phase 2: Scoring with Claude CLI...');

    // Create batches
    const batches: Array<Array<{ id: string | number; text: string }>> = [];
    for (let i = 0; i < needsLLM.length; i += BATCH_SIZE) {
      const batch = needsLLM.slice(i, i + BATCH_SIZE).map(p => ({
        id: p.id,
        text: (p.payload.chunk_text as string) || '',
      }));
      batches.push(batch);
    }

    console.log(`  Processing ${batches.length} batches (${BATCH_SIZE} chunks each)...\n`);

    let processed = 0;
    for (const batch of batches) {
      const results = await scoreBatchWithClaude(batch);

      // Update scores
      for (const result of results) {
        await updatePointScores([{ id: result.id, score: result.score }]);
      }

      processed += batch.length;
      process.stdout.write(`\r  Scored ${processed}/${needsLLM.length} chunks...`);
    }
    console.log('\n');
  }

  const totalScored = preFiltered.length + needsLLM.length;
  console.log(`Done! Scored ${totalScored} chunks.`);
  console.log(`Run with --stats to see distribution.`);
}

if (require.main === module) {
  main().catch(console.error);
}

export { preFilterScore, scoreBatchWithClaude, getPointsToScore, markAsPending, updatePointScores, bulkUpdateScoresByGroup };
