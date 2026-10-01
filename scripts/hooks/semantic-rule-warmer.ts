#!/usr/bin/env ts-node
/**
 * Semantic Rule Cache Warmer
 *
 * Spawned detached by inject-rules.js when lexical matching returns < 2 rules.
 * Embeds the prompt and finds the most similar active rules, writing the top
 * matches into .ai-memory/semantic-rule-cache.json keyed by prompt hash. The
 * NEXT prompt with the same hash benefits from the cached result (TTL 24h).
 *
 * Qdrant-free: similarity is a brute-force cosine over the active rule set
 * (~300 rules — trivially fast). Rule embeddings are cached locally in
 * .ai-memory/rule-embeddings.json (keyed by rule id + text hash) so each rule is
 * embedded only once until its text changes. No vector DB or hosting required.
 *
 * Failure modes are silent by design — this runs with stdio: 'ignore' from the
 * hook and must never surface errors to Claude Code.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { findWorkspaceRoot } from './_lib/workspace-root';

const WORKSPACE_ROOT = findWorkspaceRoot();
const CACHE_PATH = path.join(WORKSPACE_ROOT, '.ai-memory', 'semantic-rule-cache.json');
const RULE_EMB_PATH = path.join(WORKSPACE_ROOT, '.ai-memory', 'rule-embeddings.json');
const RULES_DIR = path.join(WORKSPACE_ROOT, 'scripts', 'self-improvement');
const MAX_ENTRIES = 256;
const TTL_MS = 24 * 60 * 60 * 1000;
const TOP_K = 5;

interface Rule { id: string; text: string; status: string }
interface RuleEmbedding { h: string; v: number[] }

function loadJSON<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T; } catch { return fallback; }
}

/** Active rule set: shared + personal, deduped by id (mirrors inject-rules). */
function loadActiveRules(): Rule[] {
  const shared = loadJSON<Rule[]>(path.join(RULES_DIR, 'rules-shared.json'), []);
  const personal = loadJSON<Rule[]>(path.join(RULES_DIR, 'rules.json'), []);
  const seen = new Set(shared.map(r => r.id));
  return [...shared, ...personal.filter(r => !seen.has(r.id))].filter(r => r.status === 'active' && r.text);
}

function textHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Return {ruleId -> embedding} for all active rules, embedding any new/changed
 * rule once and persisting the cache. Prunes embeddings for removed rules.
 */
async function getRuleEmbeddings(
  rules: Rule[],
  embed: (text: string) => Promise<number[]>,
): Promise<Map<string, number[]>> {
  const cache = loadJSON<Record<string, RuleEmbedding>>(RULE_EMB_PATH, {});
  const out = new Map<string, number[]>();
  const next: Record<string, RuleEmbedding> = {};
  let dirty = false;

  for (const rule of rules) {
    const h = textHash(rule.text);
    const cached = cache[rule.id];
    if (cached && cached.h === h && Array.isArray(cached.v)) {
      next[rule.id] = cached;
      out.set(rule.id, cached.v);
      continue;
    }
    const v = await embed(rule.text);
    next[rule.id] = { h, v };
    out.set(rule.id, v);
    dirty = true;
  }

  // Persist if anything changed or rules were pruned (cache had stale ids).
  if (dirty || Object.keys(cache).length !== Object.keys(next).length) {
    try {
      fs.mkdirSync(path.dirname(RULE_EMB_PATH), { recursive: true });
      const tmp = `${RULE_EMB_PATH}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, RULE_EMB_PATH);
    } catch { /* best effort */ }
  }
  return out;
}

async function main(): Promise<void> {
  const prompt = process.env.HOOK_PROMPT || '';
  const promptHash = process.env.HOOK_PROMPT_HASH || '';
  if (!prompt || !promptHash) return;

  // Lazy-load the local embedder (use require so ts-node resolves the .ts file).
  let embed: (text: string) => Promise<number[]>;
  try {
    const embedMod = require(path.join(WORKSPACE_ROOT, 'scripts', 'shared', 'embedder.ts'));
    embed = embedMod.embed;
    if (!embed) return;
  } catch {
    return;
  }

  const rules = loadActiveRules();
  if (rules.length === 0) return;

  let ids: string[];
  try {
    const [promptVec, ruleVecs] = await Promise.all([embed(prompt), getRuleEmbeddings(rules, embed)]);
    ids = rules
      .map(r => ({ id: r.id, score: ruleVecs.has(r.id) ? cosine(promptVec, ruleVecs.get(r.id)!) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .filter(r => r.score > 0)
      .map(r => r.id);
  } catch {
    return;
  }
  if (ids.length === 0) return;

  writeCacheEntry(promptHash, ids);
}

function writeCacheEntry(promptHash: string, ids: string[]): void {
  let cache: Record<string, { t: number; ids: string[] }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};
  }

  cache[promptHash] = { t: Date.now(), ids };

  // Prune expired + cap size
  const now = Date.now();
  const entries = Object.entries(cache).filter(([, v]) => v && now - v.t < TTL_MS);
  entries.sort((a, b) => b[1].t - a[1].t);
  const trimmed = Object.fromEntries(entries.slice(0, MAX_ENTRIES));

  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, CACHE_PATH);
  } catch {
    // ignored - best effort
  }
}

main().catch(() => undefined);
