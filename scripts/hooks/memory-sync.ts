#!/usr/bin/env ts-node
/**
 * Memory Sync — Stop-hook side.
 *
 * Spawned detached by session-stop.sh when a session ends. Scans the
 * Claude Code transcript for explicit memory-save intent in user turns,
 * captures the surrounding context (preceding assistant turn), and appends
 * proposals to .ai-memory/memory-proposals.jsonl for offline review via
 * `npm run memory:review`.
 *
 * Never auto-writes MEMORY.md or memory/*.md — everything lands in the
 * proposal queue. Keeps the risk of false-positive writes at zero.
 *
 * Env:
 *   TRANSCRIPT_PATH   absolute path to the session transcript (JSONL)
 *   HOOK_SESSION_ID   Claude Code session id
 *
 * Failure modes are silent by design (stdio: 'ignore' from the spawner).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { findWorkspaceRoot } from './_lib/workspace-root';

const TRANSCRIPT = process.env.TRANSCRIPT_PATH || '';
const SESSION_ID = process.env.HOOK_SESSION_ID || '';
const WORKSPACE_ROOT = findWorkspaceRoot();
const PROPOSALS = path.join(WORKSPACE_ROOT, '.ai-memory', 'memory-proposals.jsonl');

const SAVE_PATTERNS: RegExp[] = [
  /\bsave\s+(?:that\s+|this\s+|it\s+)?(?:to|in|into)\s+(?:my\s+)?memor(?:y|ies)\b/i,
  /\bremember\s+(?:this|that|it)\b/i,
  /\badd\s+(?:this\s+|that\s+|it\s+)?to\s+(?:my\s+)?memor(?:y|ies)\b/i,
  /\bnote\s+(?:this\s+|that\s+)?(?:down|for\s+later)\b/i,
  /\bstore\s+(?:this\s+|that\s+|it\s+)?(?:in|to)\s+memor(?:y|ies)\b/i,
  /\bcommit\s+(?:this\s+|that\s+)?to\s+memor(?:y|ies)\b/i,
];

function hasSaveIntent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return SAVE_PATTERNS.some(re => re.test(text));
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as { type?: string; text?: string };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

type Proposal = {
  ts: number;
  sessionId: string;
  userText: string;
  prevAssistantText: string;
  hash: string;
  status: string;
  confidence: number;
};

function hashOf(user: string, prev: string): string {
  return crypto.createHash('sha1').update(`${user}|${prev}`).digest('hex').slice(0, 16);
}

function readExistingHashes(): Set<string> {
  const seen = new Set<string>();
  try {
    const raw = fs.readFileSync(PROPOSALS, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.hash === 'string') seen.add(obj.hash);
      } catch { /* skip malformed */ }
    }
  } catch { /* no file yet */ }
  return seen;
}

function main(): void {
  if (!TRANSCRIPT || !fs.existsSync(TRANSCRIPT)) return;

  let raw: string;
  try { raw = fs.readFileSync(TRANSCRIPT, 'utf8'); }
  catch { return; }

  const lines = raw.split('\n').filter(Boolean);
  const proposals: Proposal[] = [];
  let prevAssistantText = '';

  for (const line of lines) {
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line); }
    catch { continue; }
    if (!entry || !entry.message) continue;

    const role = entry.message.role || entry.type;
    const text = extractText(entry.message.content);
    if (!text) continue;

    if (role === 'assistant') {
      prevAssistantText = text;
      continue;
    }
    if (role !== 'user') continue;

    if (hasSaveIntent(text)) {
      const userText = text.slice(0, 500);
      const prev = prevAssistantText.slice(0, 2000);
      proposals.push({
        ts: Date.now(),
        sessionId: SESSION_ID,
        userText,
        prevAssistantText: prev,
        hash: hashOf(userText, prev),
        status: 'pending-review',
        confidence: 0.7,
      });
    }
  }

  if (proposals.length === 0) return;

  const existing = readExistingHashes();
  const fresh = proposals.filter(p => !existing.has(p.hash));
  if (fresh.length === 0) return;

  try {
    fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true });
    const appended = fresh.map(p => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(PROPOSALS, appended);
  } catch {
    /* silent */
  }
}

main();
