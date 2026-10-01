import * as fs from 'fs';
import * as path from 'path';
import { embed } from '../shared/embedder';
import { deriveSessionId, loadSessionData, isSessionFile, resolveSessionsDir } from '../shared/session-file';
import { SessionChunker } from './chunker';
import { VectorEntry } from './vector-store';
import { createSessionVectorStore, SessionVectorStore } from './vector-store-factory';
import { QdrantBackupManager } from './qdrant-backup';
import chalk from 'chalk';

const DEFAULT_BACKUP_PATH = process.env.EMBEDDING_BACKUP_PATH || './backups';

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

// Lazy initialization of workspace root
let cachedWorkspaceRoot: string | null = null;
function getWorkspaceRoot(): string {
  if (!cachedWorkspaceRoot) {
    cachedWorkspaceRoot = findWorkspaceRoot();
  }
  return cachedWorkspaceRoot;
}

// For backward compatibility, create a getter
const WORKSPACE_ROOT_OBJ = { get value() { return getWorkspaceRoot(); } };
const WORKSPACE_ROOT = getWorkspaceRoot();

/**
 * Progress tracker for embedding operations
 */
class ProgressTracker {
  private startTime: number;
  private total: number;
  private current: number;
  private label: string;

  constructor(label: string, total: number) {
    this.label = label;
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
  }

  increment(): void {
    this.current++;
    this.render();
  }

  skip(): void {
    this.current++;
    this.render();
  }

  private formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  private render(): void {
    const percentage = Math.floor((this.current / this.total) * 100);
    const elapsed = Date.now() - this.startTime;
    const barWidth = 30;
    const filledWidth = Math.floor((this.current / this.total) * barWidth);
    const emptyWidth = barWidth - filledWidth;

    const bar = chalk.green('█'.repeat(filledWidth)) + chalk.gray('░'.repeat(emptyWidth));
    const counter = chalk.cyan(`${this.current}/${this.total}`);
    const percent = chalk.yellow(`${percentage}%`);
    const time = chalk.gray(`[${this.formatTime(elapsed)}]`);

    // Clear line and write progress
    process.stdout.write(`\r${this.label}: ${bar} ${counter} ${percent} ${time}`);

    // Add newline when complete
    if (this.current === this.total) {
      console.log('');
    }
  }
}

export class SessionEmbedder {
  private chunker: SessionChunker;
  private vectorStore: SessionVectorStore;

  constructor() {
    this.chunker = new SessionChunker();
    this.vectorStore = createSessionVectorStore();
  }

  async embedText(text: string): Promise<number[]> {
    return embed(text);
  }

  async embedSession(sessionPath: string, embeddedIds?: Set<string>): Promise<void> {
    const sessionId = deriveSessionId(sessionPath);

    // Use pre-fetched set if available, otherwise fall back to per-session check
    const alreadyEmbedded = embeddedIds
      ? embeddedIds.has(sessionId)
      : await this.vectorStore.hasSession(sessionId);

    if (alreadyEmbedded) {
      return;
    }

    console.log(chalk.blue(`\n📝 Embedding session: ${chalk.bold(sessionId)}`));

    const sessionData = loadSessionData(sessionPath);

    const text = this.extractSessionText(sessionData);
    const chunks = this.chunker.chunkSession(text);

    console.log(chalk.gray(`   Found ${chunks.length} chunks to process`));

    const entries: VectorEntry[] = [];
    const progress = new ProgressTracker(`   Processing chunks`, chunks.length);

    for (const chunk of chunks) {
      // Skip empty chunks
      if (!chunk.text || chunk.text.trim().length < 10) {
        progress.skip();
        continue;
      }

      const embedding = await this.embedText(chunk.text);

      const entry: VectorEntry = {
        id: `${sessionId}-chunk-${chunk.index}`,
        session_id: sessionId,
        chunk_text: chunk.text,
        embedding,
        metadata: {
          date: sessionData.exportedAt || sessionData.startTime || sessionData.timestamp || new Date().toISOString(),
          chunk_index: chunk.index,
        },
      };

      entries.push(entry);
      progress.increment();
    }

    if (entries.length > 0) {
      await this.vectorStore.addBatch(entries);
      console.log(chalk.green(`   ✅ Embedded ${entries.length} chunks successfully\n`));
    } else {
      console.log(chalk.yellow(`   ⚠️  No valid chunks to embed (all chunks were too small)\n`));
    }
  }

  private extractSessionText(sessionData: any): string {
    const parts: string[] = [];

    if (sessionData.messages && Array.isArray(sessionData.messages)) {
      for (const msg of sessionData.messages) {
        // Handle Claude Code session format
        if (msg.message && msg.message.role && msg.message.content) {
          const role = msg.message.role;
          const content = typeof msg.message.content === 'string'
            ? msg.message.content
            : JSON.stringify(msg.message.content);

          // Skip meta messages and empty content
          if (!msg.isMeta && content && content.length > 10) {
            parts.push(`[${role}]: ${content}`);
          }
        }
        // Handle standard message format
        else if (msg.role && msg.content) {
          parts.push(`[${msg.role}]: ${msg.content}`);
        }
      }
    } else if (sessionData.conversation) {
      parts.push(JSON.stringify(sessionData.conversation, null, 2));
    } else if (typeof sessionData === 'string') {
      parts.push(sessionData);
    } else {
      parts.push(JSON.stringify(sessionData, null, 2));
    }

    return parts.join('\n\n');
  }

  async embedSessionsInDirectory(dirPath: string, backupPath?: string): Promise<void> {
    console.log(chalk.cyan(`\n🔍 Scanning directory: ${dirPath}`));

    if (!fs.existsSync(dirPath)) {
      console.log(chalk.yellow(`\n⚠ Directory not found: ${dirPath}`));
      console.log(chalk.gray(`  No sessions to embed. Run some Claude Code sessions first.`));
      return;
    }

    const allFiles = fs.readdirSync(dirPath).filter(isSessionFile);

    // Fetch all embedded session IDs upfront (single Qdrant scroll) instead of per-file checks
    console.log(chalk.cyan(`📊 Found ${chalk.bold(String(allFiles.length))} session files on disk`));
    console.log(chalk.gray(`   Fetching embedded session index from Qdrant...`));

    const embeddedIds = await this.vectorStore.getEmbeddedSessionIds();
    const newFiles = allFiles.filter(f => !embeddedIds.has(deriveSessionId(f)));
    const skipped = allFiles.length - newFiles.length;

    console.log(chalk.cyan(`   ${chalk.green.bold(String(newFiles.length))} new sessions to embed, ${chalk.yellow(String(skipped))} already embedded\n`));

    let processed = 0;
    let errors = 0;

    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i];
      const fullPath = path.join(dirPath, file);

      console.log(chalk.gray(`─────────────────────────────────────────────────────────────────────`));
      console.log(chalk.magenta(`[${i + 1}/${newFiles.length}] Processing: ${file}`));

      try {
        await this.embedSession(fullPath, embeddedIds);
        processed++;
      } catch (error) {
        errors++;
        console.error(chalk.red(`   ❌ Error embedding ${file}:`), error);
      }
    }

    console.log(chalk.gray(`─────────────────────────────────────────────────────────────────────`));

    const stats = await this.vectorStore.getStats();
    console.log(chalk.green.bold('\n✨ Embedding complete!\n'));
    console.log(chalk.cyan('📈 Summary:'));
    console.log(`   Sessions processed: ${chalk.green(String(processed))}`);
    console.log(`   Sessions skipped:   ${chalk.yellow(String(skipped))}`);
    console.log(`   Errors:             ${errors > 0 ? chalk.red(String(errors)) : chalk.green('0')}`);
    console.log(chalk.cyan('\n📊 Vector Store Statistics:'));
    console.log(`   Total sessions:     ${chalk.bold(String(stats.total_sessions))}`);
    console.log(`   Total chunks:       ${chalk.bold(String(stats.total_chunks))}`);
    console.log(`   Storage size:       ${chalk.bold(stats.storage_size_mb + ' MB')}`);

    // Perform backup if path is provided
    if (backupPath) {
      try {
        const backupManager = new QdrantBackupManager(backupPath);
        await backupManager.backup();
      } catch (error) {
        console.error(chalk.red('⚠️  Backup failed (embedding was successful):'), error);
      }
    }

    console.log('');
  }
}

/**
 * Timer for tracking duration of each pipeline step.
 */
class StepTimer {
  private timings: Array<{ step: string; result: string; durationMs: number }> = [];
  private stepStart: number = 0;

  startStep(): void {
    this.stepStart = Date.now();
  }

  endStep(step: string, result: string): void {
    this.timings.push({ step, result, durationMs: Date.now() - this.stepStart });
  }

  formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  printSummary(): void {
    const totalMs = this.timings.reduce((sum, t) => sum + t.durationMs, 0);
    console.log(chalk.cyan('\n' + '='.repeat(65)));
    console.log(chalk.cyan.bold('  Pipeline Summary'));
    console.log(chalk.cyan('='.repeat(65)));
    for (const { step, result, durationMs } of this.timings) {
      const duration = chalk.gray(this.formatDuration(durationMs).padStart(8));
      console.log(`  ${chalk.bold(step.padEnd(22))} ${result.padEnd(45)} ${duration}`);
    }
    console.log(chalk.cyan('─'.repeat(65)));
    console.log(`  ${chalk.bold('Total'.padEnd(22))} ${' '.repeat(45)} ${chalk.gray(this.formatDuration(totalMs).padStart(8))}`);
    console.log('');
  }
}

/**
 * Run the self-improvement pipeline after embedding.
 * Each step is wrapped in try/catch so failures don't block subsequent steps.
 */
async function runSelfImprovementPipeline(): Promise<void> {
  console.log(chalk.cyan('\n' + '='.repeat(65)));
  console.log(chalk.cyan.bold('  Self-Improvement Pipeline'));
  console.log(chalk.cyan('='.repeat(65) + '\n'));

  const timer = new StepTimer();

  // Step 1: Score new chunks
  timer.startStep();
  try {
    console.log(chalk.blue('Step 1/8: Scoring new chunks...'));
    const { getPointsToScore, preFilterScore, scoreBatchWithClaude, updatePointScores, bulkUpdateScoresByGroup } = await import('./quality-scorer');
    const points = await getPointsToScore({});
    if (points.length > 0) {
      // Phase 1: Pre-filter obvious noise with heuristics
      const preFilteredItems: Array<{ id: string | number; score: number }> = [];
      const needsLLMPoints: Array<{ id: string | number; payload: Record<string, unknown> }> = [];

      for (const point of points) {
        const chunkText = (point.payload.chunk_text as string) || '';
        const score = preFilterScore(chunkText);
        if (score !== null) {
          preFilteredItems.push({ id: point.id, score });
        } else {
          needsLLMPoints.push(point);
        }
      }

      console.log(chalk.green(`   Found ${points.length} chunks to score (${preFilteredItems.length} pre-filtered, ${needsLLMPoints.length} need LLM)`));

      // Write pre-filtered scores to Qdrant in bulk
      if (preFilteredItems.length > 0) {
        console.log(chalk.gray(`   Writing ${preFilteredItems.length} pre-filtered scores...`));
        await bulkUpdateScoresByGroup(preFilteredItems);
      }

      // Phase 2: Score remaining chunks with Claude CLI
      if (needsLLMPoints.length > 0) {
        const BATCH_SIZE = 25;
        const batches: Array<Array<{ id: string | number; text: string }>> = [];
        for (let i = 0; i < needsLLMPoints.length; i += BATCH_SIZE) {
          batches.push(needsLLMPoints.slice(i, i + BATCH_SIZE).map(p => ({
            id: p.id,
            text: (p.payload.chunk_text as string) || '',
          })));
        }
        console.log(chalk.gray(`   LLM scoring ${needsLLMPoints.length} chunks in ${batches.length} batches...`));

        let scored = 0;
        for (const batch of batches) {
          const results = await scoreBatchWithClaude(batch);
          for (const result of results) {
            await updatePointScores([{ id: result.id, score: result.score }]);
          }
          scored += batch.length;
          process.stdout.write(`\r   Scored ${scored}/${needsLLMPoints.length} chunks...`);
        }
        console.log('');
      }

      timer.endStep('Score chunks', `${points.length} chunks (${preFilteredItems.length} pre-filtered)`);
    } else {
      timer.endStep('Score chunks', 'All scored');
      console.log(chalk.gray('   All chunks already scored'));
    }
  } catch (err) {
    timer.endStep('Score chunks', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 2: Extract insights
  timer.startStep();
  try {
    console.log(chalk.blue('\nStep 2/8: Extracting insights...'));
    const { extractInsights } = await import('../self-improvement/insight-extractor');
    const insightCount = await extractInsights();
    timer.endStep('Extract insights', `${insightCount} insight(s)`);
    console.log(chalk.green(`   Extracted ${insightCount} insight(s)`));
  } catch (err) {
    timer.endStep('Extract insights', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 3: Generate reflections
  timer.startStep();
  try {
    console.log(chalk.blue('\nStep 3/8: Generating reflections...'));
    const { generateReflectionsFromSessions } = await import('../self-improvement/reflection-generator');
    const reflectionCount = await generateReflectionsFromSessions();
    timer.endStep('Generate reflections', `${reflectionCount} reflection(s)`);
    console.log(chalk.green(`   Generated ${reflectionCount} reflection(s)`));
  } catch (err) {
    timer.endStep('Generate reflections', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 4: Check for novel skills
  timer.startStep();
  try {
    console.log(chalk.blue('\nStep 4/8: Checking for novel skills...'));
    const sessionsDir = resolveSessionsDir(getWorkspaceRoot());
    if (fs.existsSync(sessionsDir)) {
      const { checkAndProposeSkill, loadSkillState, saveSkillState } = await import('../self-improvement/skill-generator');
      const skillState = loadSkillState();
      const allFiles = fs.readdirSync(sessionsDir).filter(isSessionFile);
      const files = allFiles.filter(f => !skillState.processedSessions[deriveSessionId(f)]);
      const skippedCount = allFiles.length - files.length;

      if (files.length === 0) {
        console.log(chalk.gray(`   No new sessions to check (${skippedCount} already checked)`));
        timer.endStep('Propose skills', `0 new (${skippedCount} already checked)`);
      } else {
        console.log(chalk.gray(`   ${files.length} new sessions to check (${skippedCount} already checked)`));
        let proposed = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const sessionId = deriveSessionId(file);
          console.log(chalk.gray(`   Checking session ${i + 1}/${files.length} for novel patterns...`));
          try {
            const result = await checkAndProposeSkill(path.join(sessionsDir, file));
            skillState.processedSessions[sessionId] = {
              date: new Date().toISOString(),
              proposed: result !== null,
            };
            if (result) proposed++;
          } catch {
            skillState.processedSessions[sessionId] = {
              date: new Date().toISOString(),
              proposed: false,
            };
          }
        }
        saveSkillState(skillState);
        timer.endStep('Propose skills', `${proposed} proposed (${files.length} new, ${skippedCount} skipped)`);
        console.log(chalk.green(`   Proposed ${proposed} skill(s)`));
      }
    } else {
      timer.endStep('Propose skills', 'No sessions dir');
      console.log(chalk.gray('   No sessions directory'));
    }
  } catch (err) {
    timer.endStep('Propose skills', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 5: Track reinforcements
  timer.startStep();
  try {
    console.log(chalk.blue('\nStep 5/8: Tracking reinforcements...'));
    const { trackReinforcement } = await import('../self-improvement/reinforcement-tracker');
    await trackReinforcement();
    timer.endStep('Reinforcement', 'Done');
    console.log(chalk.green('   Done'));
  } catch (err) {
    timer.endStep('Reinforcement', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 6: Prune stale rules
  timer.startStep();
  try {
    console.log(chalk.blue('\nStep 6/8: Pruning stale rules...'));
    const { pruneStaleRules } = await import('../self-improvement/reinforcement-tracker');
    const { pruned, flagged } = await pruneStaleRules();
    timer.endStep('Prune rules', `${pruned} pruned, ${flagged} flagged`);
    console.log(chalk.green(`   Pruned ${pruned}, flagged ${flagged}`));
  } catch (err) {
    timer.endStep('Prune rules', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 7: Sync rules to Qdrant
  timer.startStep();
  try {
    console.log(chalk.blue('\nStep 7/8: Syncing rules to Qdrant...'));
    const { syncRulesToQdrant } = await import('../self-improvement/proposal-manager');
    const synced = await syncRulesToQdrant();
    timer.endStep('Sync rules', `${synced} synced`);
    console.log(chalk.green(`   Synced ${synced} rule(s)`));
  } catch (err) {
    timer.endStep('Sync rules', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  // Step 8: Generate unified dashboard
  timer.startStep();
  let dashboardOutputPath = '';
  try {
    console.log(chalk.blue('\nStep 8/8: Generating dashboard...'));
    const { generateDashboard } = await import('./dashboard-generator');
    dashboardOutputPath = await generateDashboard();
    timer.endStep('Dashboard', 'Generated');
    console.log(chalk.green('   Dashboard generated'));
  } catch (err) {
    timer.endStep('Dashboard', `Skipped: ${(err as Error).message}`);
    console.log(chalk.yellow(`   Skipped: ${(err as Error).message}`));
  }

  timer.printSummary();

  // Open the dashboard in the default browser
  if (dashboardOutputPath) {
    const htmlPath = path.join(path.dirname(dashboardOutputPath), 'dashboard.html');
    if (fs.existsSync(htmlPath)) {
      const { exec } = await import('child_process');
      const cmd = process.platform === 'win32' ? `start "" "${htmlPath}"`
        : process.platform === 'darwin' ? `open "${htmlPath}"`
        : `xdg-open "${htmlPath}"`;
      exec(cmd);
      console.log(chalk.green(`\n  Opening dashboard: ${htmlPath}`));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const embedder = new SessionEmbedder();
  const backupPath = process.env.EMBEDDING_BACKUP_PATH || DEFAULT_BACKUP_PATH;

  if (command === 'embed') {
    const sessionPath = args[1];
    const skipBackup = args.includes('--no-backup');
    const embedOnly = args.includes('--embed-only');
    const rebuild = args.includes('--rebuild');

    if (rebuild) {
      console.log(chalk.yellow('🔄 Rebuilding: deleting existing collection...'));
      const vectorStore = createSessionVectorStore();
      await vectorStore.deleteCollection();
      console.log(chalk.green('   Collection deleted. Re-embedding all sessions.\n'));
    }

    if (!sessionPath || sessionPath.startsWith('--')) {
      const defaultPath = resolveSessionsDir(WORKSPACE_ROOT);
      await embedder.embedSessionsInDirectory(defaultPath, skipBackup ? undefined : backupPath);
    } else if (fs.existsSync(sessionPath) && fs.statSync(sessionPath).isDirectory()) {
      await embedder.embedSessionsInDirectory(sessionPath, skipBackup ? undefined : backupPath);
    } else if (fs.existsSync(sessionPath)) {
      await embedder.embedSession(sessionPath);
    } else {
      console.error(`Error: Path not found: ${sessionPath}`);
      process.exit(1);
    }

    // Run self-improvement pipeline unless --embed-only
    if (!embedOnly) {
      await runSelfImprovementPipeline();
    }
  } else if (command === 'stats') {
    const vectorStore = createSessionVectorStore();
    const stats = await vectorStore.getStats();
    console.log('Vector Store Statistics:');
    console.log(`  Model: ${stats.model}`);
    console.log(`  Dimensions: ${stats.dimensions}`);
    console.log(`  Total sessions: ${stats.total_sessions}`);
    console.log(`  Total chunks: ${stats.total_chunks}`);
    console.log(`  Storage size: ${stats.storage_size_mb} MB`);
    if (stats.qdrant_status) {
      console.log(`  Status: ${stats.qdrant_status}`);
    }
  } else {
    console.log('Session Embedder + Self-Improvement Pipeline');
    console.log('');
    console.log('Usage:');
    console.log('  npm run session:embed                    - Embed + full self-improvement pipeline');
    console.log('  npm run session:embed -- --embed-only    - Embed only, skip self-improvement');
    console.log('  npm run session:embed -- --rebuild       - Delete collection and re-embed everything');
    console.log('  npm run session:embed -- --no-backup     - Skip backup step');
    console.log('  npm run session:stats                    - Show vector store statistics');
    console.log('');
    console.log('Pipeline steps (after embedding):');
    console.log('  1. Score new chunks (heuristic + Claude CLI)');
    console.log('  2. Extract insights from session pairs');
    console.log('  3. Generate reflections from failures');
    console.log('  4. Check for novel skills');
    console.log('  5. Track rule reinforcements');
    console.log('  6. Prune stale rules');
    console.log('  7. Sync rules to Qdrant');
    console.log('  8. Generate dashboard');
    console.log('');
    console.log('Environment:');
    console.log(`  EMBEDDING_BACKUP_PATH            - Custom backup path (default: ${DEFAULT_BACKUP_PATH})`);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
