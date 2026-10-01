import * as fs from 'fs';
import * as path from 'path';
import { embed } from '../shared/embedder';
import { createSessionVectorStore } from './vector-store-factory';
import { formatStaleness, deduplicateBySession, sessionDiversityCount } from './result-enhancer';

function logSearch(source: string, query: string, resultsCount: number, topScore: number, topSessionId: string, durationMs: number) {
  try {
    const logDir = path.join(__dirname, '../../.claude/logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'search-log.jsonl');
    const entry = { timestamp: new Date().toISOString(), source, query, resultsCount, topScore, topSessionId, durationMs };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {}

  // Also log value event
  logValueEvent(source, query, resultsCount);
}

function logValueEvent(source: string, query: string, resultsCount: number) {
  try {
    const logDir = path.join(__dirname, '../../.claude/logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'value-events.jsonl');

    // Read session ID from active session
    let sessionId = '';
    try {
      const sessionFile = path.join(__dirname, '../../.claude/logs/sessions/active-session.json');
      if (fs.existsSync(sessionFile)) {
        const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        sessionId = data.sessionId || '';
      }
    } catch {}

    const event = {
      timestamp: new Date().toISOString(),
      sessionId,
      type: 'session_search',
      count: resultsCount,
      details: { source, query },
    };
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  } catch {}
}

async function search(query: string, topK: number = 5) {
  const startTime = Date.now();
  console.log(`Searching for: "${query}"\n`);

  const vectorStore = createSessionVectorStore();

  const queryEmbedding = await embed(query);

  // Fetch extra results for deduplication, then reduce to topK
  const rawResults = await vectorStore.search(queryEmbedding, topK * 3);

  if (rawResults.length === 0) {
    logSearch('search', query, 0, 0, '', Date.now() - startTime);
    console.log('No results found.');
    return;
  }

  const results = deduplicateBySession(rawResults, topK);

  logSearch('search', query, results.length, results[0].score, results[0].session_id, Date.now() - startTime);

  const uniqueSessions = sessionDiversityCount(results);
  console.log(`Found ${results.length} results from ${uniqueSessions} sessions:\n`);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const score = (result.score * 100).toFixed(1);
    const staleness = formatStaleness(result.metadata.date);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`Result ${i + 1} - Score: ${score}% - Session: ${result.session_id}`);
    console.log(`Date: ${result.metadata.date} | Age: ${staleness}`);
    console.log(`Chunk: ${result.metadata.chunk_index + 1}`);
    console.log(`${'='.repeat(80)}`);

    const preview = result.chunk_text.length > 500
      ? result.chunk_text.substring(0, 500) + '...'
      : result.chunk_text;

    console.log(preview);
  }

  console.log(`\n${'='.repeat(80)}\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Session Search');
    console.log('');
    console.log('Usage:');
    console.log('  npm run search "your query here"');
    console.log('  npm run search "your query" 10         - Return top 10 results');
    console.log('');
    console.log('Examples:');
    console.log('  npm run search "how did I implement Supabase realtime?"');
    console.log('  npm run search "React hooks with TypeScript"');
    console.log('  npm run search "database schema decisions"');
    return;
  }

  const query = args[0];
  const topK = args[1] ? parseInt(args[1], 10) : 5;

  await search(query, topK);
}

if (require.main === module) {
  main().catch(console.error);
}
