#!/usr/bin/env ts-node
/**
 * Memory Review CLI (`npm run memory:review`).
 *
 * Walks pending proposals from .ai-memory/memory-proposals.jsonl, shows each
 * one, and lets the user accept (writes a new memory file + MEMORY.md index
 * entry), reject (marks as dismissed), or skip. Non-interactive flags are
 * supported for scripting.
 *
 * Usage:
 *   npx ts-node scripts/hooks/memory-review.ts                 # interactive
 *   npx ts-node scripts/hooks/memory-review.ts --list          # list + exit
 *   npx ts-node scripts/hooks/memory-review.ts --prune 14      # drop entries older than N days
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { findWorkspaceRoot } from './_lib/workspace-root';

type Proposal = {
  ts: number;
  sessionId: string;
  userText: string;
  prevAssistantText: string;
  hash: string;
  status: string;
  confidence: number;
};

const WORKSPACE_ROOT = findWorkspaceRoot();
const PROPOSALS = path.join(WORKSPACE_ROOT, '.ai-memory', 'memory-proposals.jsonl');

function encodeWorkspaceForClaudeProjects(root: string): string {
  return '-' + root.replace(/[\/\\]/g, '-').replace(/^-+/, '');
}

function memoryDir(): string {
  const encoded = encodeWorkspaceForClaudeProjects(WORKSPACE_ROOT);
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
}

function loadAll(): Proposal[] {
  try {
    const raw = fs.readFileSync(PROPOSALS, 'utf8');
    const entries: Proposal[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); }
      catch { /* skip malformed */ }
    }
    return entries;
  } catch {
    return [];
  }
}

function saveAll(entries: Proposal[]): void {
  fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true });
  const tmp = `${PROPOSALS}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, PROPOSALS);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'memory';
}

function writeMemoryFile(
  slug: string,
  title: string,
  type: string,
  description: string,
  body: string,
): string {
  const dir = memoryDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${slug}.md`;
  const filePath = path.join(dir, file);
  const frontmatter = [
    '---',
    `name: ${title}`,
    `description: ${description.replace(/\n/g, ' ').slice(0, 200)}`,
    `type: ${type}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(filePath, frontmatter);
  return file;
}

function appendToIndex(title: string, file: string, hook: string): void {
  const indexPath = path.join(memoryDir(), 'MEMORY.md');
  let existing = '';
  try { existing = fs.readFileSync(indexPath, 'utf8'); } catch { /* create */ }

  const trimmed = hook.length > 100 ? hook.slice(0, 97) + '...' : hook;
  const line = `- [${title}](${file}) — ${trimmed}`;
  if (existing.includes(`](${file})`)) return;

  const header = existing.startsWith('# Memory Index') ? existing : '# Memory Index\n' + existing;
  const next = header.trimEnd() + '\n' + line + '\n';
  fs.writeFileSync(indexPath, next);
}

function prompt(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, resolve));
}

async function interactive(): Promise<void> {
  const all = loadAll();
  const pending = all.filter(p => p.status === 'pending-review');
  if (pending.length === 0) {
    console.log('No pending memory proposals.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    console.log(`\n── Proposal ${i + 1}/${pending.length} — ${new Date(p.ts).toISOString()}`);
    console.log(`User said:     ${p.userText}`);
    console.log(`Prior context: ${p.prevAssistantText.slice(0, 300)}${p.prevAssistantText.length > 300 ? '…' : ''}`);
    const action = (await prompt(rl, 'Action? [a]ccept / [r]eject / [s]kip: ')).trim().toLowerCase();

    if (action === 'a' || action === 'accept') {
      const title = (await prompt(rl, 'Title: ')).trim();
      if (!title) { console.log('skipped (no title)'); continue; }
      const type = ((await prompt(rl, 'Type (user/feedback/project/reference) [feedback]: ')).trim() || 'feedback');
      const description = (await prompt(rl, 'Description (one-line): ')).trim() || title;
      const body = (await prompt(rl, 'Body (or press enter to use userText verbatim): ')).trim() || p.userText;

      const slug = slugify(`${type}_${title}`);
      const file = writeMemoryFile(slug, title, type, description, body);
      appendToIndex(title, file, description);
      p.status = 'accepted';
      console.log(`  → wrote ${file}`);
    } else if (action === 'r' || action === 'reject') {
      p.status = 'dismissed';
      console.log('  → dismissed');
    } else {
      console.log('  → skipped');
    }
  }

  rl.close();
  saveAll(all);
  console.log('\nDone.');
}

function listAll(): void {
  const all = loadAll();
  if (all.length === 0) { console.log('No proposals.'); return; }
  for (const p of all) {
    console.log(`[${p.status}] ${new Date(p.ts).toISOString()} :: ${p.userText.slice(0, 80)}`);
  }
}

function prune(days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = loadAll();
  const kept = all.filter(p => p.ts >= cutoff || p.status === 'pending-review');
  saveAll(kept);
  console.log(`Pruned ${all.length - kept.length} entries older than ${days} days.`);
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  listAll();
} else if (args[0] === '--prune') {
  prune(parseInt(args[1] || '14', 10) || 14);
} else {
  interactive().catch(err => {
    console.error('memory:review error:', err?.message || err);
    process.exit(1);
  });
}
