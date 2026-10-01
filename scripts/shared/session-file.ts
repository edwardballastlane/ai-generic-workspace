import * as fs from 'fs';
import * as path from 'path';

/**
 * Derive the session id from a session file path. Handles both the original
 * `.json` export format and Claude Code's native `.jsonl` transcripts.
 */
export function deriveSessionId(filePath: string): string {
  const base = path.basename(filePath);
  if (base.endsWith('.jsonl')) return base.slice(0, -'.jsonl'.length);
  if (base.endsWith('.json'))  return base.slice(0, -'.json'.length);
  return base;
}

/**
 * Load a session file into the `{ messages, timestamp, ... }` shape expected
 * by consumers (embedder, reflection generator, etc). `.json` is parsed as a
 * single object. `.jsonl` is parsed line-by-line — each non-empty line is one
 * message — and wrapped into `{ messages, timestamp }`. The first valid
 * timestamp is surfaced so date-metadata paths keep working.
 */
export function loadSessionData(sessionPath: string): any {
  const content = fs.readFileSync(sessionPath, 'utf8');
  if (!sessionPath.endsWith('.jsonl')) {
    return JSON.parse(content);
  }
  const messages: any[] = [];
  let firstTimestamp: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      messages.push(parsed);
      if (!firstTimestamp && parsed.timestamp) firstTimestamp = parsed.timestamp;
    } catch {
      // Skip malformed lines rather than failing the whole session.
    }
  }
  return { messages, timestamp: firstTimestamp };
}

/** Accept `.json` and `.jsonl` filenames. */
export function isSessionFile(filename: string): boolean {
  return filename.endsWith('.json') || filename.endsWith('.jsonl');
}

/**
 * Resolve the directory where session transcripts live.
 *
 * Priority:
 *   1. process.env.REFLECTION_SESSIONS_DIR (explicit override)
 *   2. <workspaceRoot>/.claude/logs/sessions if it exists AND contains at
 *      least one .json/.jsonl file (legacy export path)
 *   3. ~/.claude/projects/<encoded-workspace-path> — where Claude Code
 *      actually writes .jsonl transcripts today.
 *
 * All call sites (embedder, reflection-generator, skill-generator probe
 * in runSelfImprovementPipeline) share this so behavior can't drift.
 */
export function resolveSessionsDir(workspaceRoot: string): string {
  if (process.env.REFLECTION_SESSIONS_DIR) return process.env.REFLECTION_SESSIONS_DIR;
  const legacy = path.join(workspaceRoot, '.claude/logs/sessions');
  if (fs.existsSync(legacy) && fs.readdirSync(legacy).some(isSessionFile)) {
    return legacy;
  }
  const home = process.env.HOME || '';
  const encoded = workspaceRoot.replace(/\//g, '-');
  return path.join(home, '.claude', 'projects', encoded);
}
