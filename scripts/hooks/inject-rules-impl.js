/**
 * Inject Rules — impl module.
 *
 * Exports run({ prompt, cwd, workspaceRoot }) → string.
 * Called in-process by user-prompt-dispatcher.js AND (via the thin shim
 * scripts/hooks/inject-rules.js) as a standalone hook for backwards compat.
 *
 * Scoring: Jaccard similarity on stopword-filtered tokens, two-tier threshold,
 * with Qdrant-cache semantic fallback when lexical returns < 2 matches.
 *
 * Optional MEMORY.md section injection (#5): gated on INJECT_MEMORY_SECTIONS!=0,
 * scored with the same Jaccard engine and appended as a separate block.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnWarmer } = require('./spawn-warmer');
const detectedProjectCache = require('./_lib/detected-project');

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','are','not','but','you','have',
  'can','was','were','will','would','should','could','has','had','your','their',
  'there','these','those','what','when','where','which','how','why','any','all',
  'some','more','than','then','also','into','out','off','about','because','over',
  'under','between','among','use','used','using','run','get','set','make','made',
  'take','taken','put','see','look','find','found','know','think','like','want',
  'need','say','said','tell','told','ask','asked','help','our','its','just','too',
  'very','such','only','one','two','here','now','yet','own','does','done','doing',
]);

function tokenize(text) {
  return Array.from(new Set(
    String(text).toLowerCase()
      .replace(/[^a-z0-9\s\-_.]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  ));
}

function jaccard(setA, tokensB) {
  if (setA.size === 0 || tokensB.length === 0) return 0;
  let intersection = 0;
  for (const t of tokensB) if (setA.has(t)) intersection++;
  const union = setA.size + tokensB.length - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Read `project:` value from a YAML-ish file by scanning lines — mirrors the
 * pure-bash parser in inject-context.sh so behaviour stays aligned. Only used
 * for current.yaml where the schema is fixed and a real YAML parser would be
 * overkill for a single field.
 */
function readProjectFromYaml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*project:\s*(.+?)\s*$/);
      if (!m) continue;
      const val = m[1].replace(/^["']|["']$/g, '').trim();
      if (val && val !== 'unspecified') return val;
    }
  } catch { /* missing / unreadable — fall through */ }
  return null;
}

function readProjectFromSidecar(workspaceRoot, sessionId) {
  if (!sessionId) return null;
  const sidecar = path.join(workspaceRoot, '.ai-session', 'by-id', `${sessionId}.json`);
  try {
    const obj = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    const p = obj && typeof obj.project === 'string' ? obj.project.trim() : '';
    return p && p !== 'unspecified' ? p : null;
  } catch {
    return null;
  }
}

function readProjectFromDetectedFile(workspaceRoot, sessionId) {
  // Gated read — only returns the cache value when it was written by the
  // current cc session, so a parallel terminal's project cannot leak in.
  const val = detectedProjectCache.read(workspaceRoot, sessionId);
  return val && val !== 'unspecified' ? val : null;
}

function listProjects(workspaceRoot) {
  const projectsDir = path.join(workspaceRoot, 'agent', '_projects');
  if (!fs.existsSync(projectsDir)) return [];
  try {
    return fs.readdirSync(projectsDir).filter(f => f !== '.gitkeep');
  } catch {
    return [];
  }
}

function detectFromCwd(workspaceRoot, projects, cwd) {
  if (!cwd) return null;
  const projectsDir = path.join(workspaceRoot, 'agent', '_projects');
  for (const p of projects) {
    const projectPath = path.join(projectsDir, p);
    let realPath;
    try { realPath = fs.realpathSync(projectPath); } catch { continue; }
    if (cwd.startsWith(realPath) || cwd.includes(p)) return p;
  }
  return null;
}

function detectFromPrompt(projects, promptLower) {
  for (const p of projects) {
    if (promptLower.includes(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * Determine the active project for rule boosting, in priority order:
 *   1. Per-session sidecar (.ai-session/by-id/<sid>.json .project)      ← set by inject-context.sh on first prompt
 *   2. Active session yaml (.ai-session/current.yaml task.project)       ← set by ./scripts/start-session
 *   3. Cached detected-project file (.ai-session/detected-project)
 *   4. cwd match against agent/_projects/<name>
 *   5. Project name appearing in the prompt text
 *
 * The first three sources are authoritative (they were already chosen by the
 * session tooling); the last two are best-effort guesses. Returning the
 * authoritative project is what closes the "project: unknown" tagging gap —
 * we were previously only using #4 and #5.
 */
function detectProject(workspaceRoot, cwd, promptLower, sessionId) {
  const projects = listProjects(workspaceRoot);
  if (projects.length === 0) return null;
  const valid = new Set(projects);
  const pick = v => (v && valid.has(v)) ? v : null;

  // Phase B: prefer .ai-session/by-id/<sessionId>.yaml over the shared
  // current.yaml so a parallel terminal's session binding cannot leak in.
  const sessionYaml = sessionId
    ? path.join(workspaceRoot, '.ai-session', 'by-id', `${sessionId}.yaml`)
    : '';
  const sharedYaml = path.join(workspaceRoot, '.ai-session', 'current.yaml');
  return (
    pick(readProjectFromSidecar(workspaceRoot, sessionId))
    || (sessionYaml && pick(readProjectFromYaml(sessionYaml)))
    || pick(readProjectFromYaml(sharedYaml))
    || pick(readProjectFromDetectedFile(workspaceRoot, sessionId))
    || detectFromCwd(workspaceRoot, projects, cwd)
    || detectFromPrompt(projects, promptLower)
  );
}

function loadJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function loadRules(rulesDir) {
  const shared = loadJSON(path.join(rulesDir, 'rules-shared.json'), [])
    .map(r => ({ ...r, _source: 'team' }));
  const personal = loadJSON(path.join(rulesDir, 'rules.json'), [])
    .map(r => ({ ...r, _source: 'personal' }));
  const seen = new Set(shared.map(r => r.id));
  return [...shared, ...personal.filter(r => !seen.has(r.id))];
}

function scoreRules(rules, promptSet, activeProject) {
  const activeLower = activeProject ? activeProject.toLowerCase() : null;
  const scored = [];
  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    const ruleTokens = tokenize(rule.text + ' ' + (rule.categories || []).join(' '));
    let score = jaccard(promptSet, ruleTokens);
    if (score === 0) continue;
    if (activeLower && (rule.projects || []).some(p => String(p).toLowerCase() === activeLower)) {
      score += 0.03;
    }
    if (rule._source === 'team') score += 0.01;
    scored.push({ rule, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function readSemanticCache(cachePath, promptHash, rules, excludeIds) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const entry = cache && cache[promptHash];
    const TTL_MS = 24 * 60 * 60 * 1000;
    if (!entry || typeof entry.t !== 'number' || Date.now() - entry.t >= TTL_MS) return [];
    if (!Array.isArray(entry.ids)) return [];
    const byId = new Map(rules.map(r => [r.id, r]));
    return entry.ids
      .map(id => byId.get(id))
      .filter(r => r && !excludeIds.has(r.id))
      .slice(0, 3);
  } catch {
    return [];
  }
}

// ─── MEMORY.md section injection (#5) ─────────────────────────────────
function encodeWorkspaceForClaudeProjects(workspaceRoot) {
  // Matches Claude Code's own path encoding: leading dash, slashes → dashes
  return '-' + workspaceRoot.replace(/[\/\\]/g, '-').replace(/^-+/, '');
}

function memoryDir(workspaceRoot) {
  const home = process.env.HOME || os.homedir();
  const encoded = encodeWorkspaceForClaudeProjects(workspaceRoot);
  return path.join(home, '.claude', 'projects', encoded, 'memory');
}

function parseMemorySections(memoryMdPath, dir) {
  let raw;
  try { raw = fs.readFileSync(memoryMdPath, 'utf8'); }
  catch { return []; }

  const sections = [];
  const entryRegex = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*(.*))?$/gm;
  let match;
  while ((match = entryRegex.exec(raw)) !== null) {
    const title = match[1].trim();
    const fileName = match[2].trim();
    const hook = (match[3] || '').trim();
    if (!fileName.endsWith('.md') || fileName === 'MEMORY.md') continue;
    // Defense-in-depth: MEMORY.md is author-trusted, but reject traversal
    // so a hand-edited bad link can't pull arbitrary files into the prompt.
    if (fileName.includes('..') || path.isAbsolute(fileName)) continue;

    const filePath = path.join(dir, fileName);
    let body = '';
    try { body = fs.readFileSync(filePath, 'utf8'); }
    catch { /* missing file → use hook line only */ }

    sections.push({
      title,
      hook,
      filePath,
      fileName,
      body,
      combined: title + ' ' + hook + ' ' + body,
    });
  }
  return sections;
}

function scoreMemories(sections, promptSet) {
  const scored = [];
  for (const s of sections) {
    const toks = tokenize(s.combined);
    const score = jaccard(promptSet, toks);
    if (score > 0) scored.push({ section: s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function firstMeaningfulLine(body, hook) {
  if (hook) return hook.length > 140 ? hook.slice(0, 137) + '…' : hook;
  if (!body) return '';
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('name:') || trimmed.startsWith('description:') || trimmed.startsWith('type:')) continue;
    return trimmed.length > 140 ? trimmed.slice(0, 137) + '…' : trimmed;
  }
  return '';
}

/**
 * Atomic counter bump on the per-session sidecar so statusline / rules:stats
 * can report "this session". No-op if the sidecar doesn't exist yet (the
 * bash inject-context.sh normally creates it before this module runs).
 */
function bumpSidecar(workspaceRoot, sessionId, deltas) {
  if (!sessionId) return;
  const sidecarDir = path.join(workspaceRoot, '.ai-session', 'by-id');
  const sidecar = path.join(sidecarDir, `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(sidecar, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(deltas)) {
      obj[k] = (obj[k] || 0) + v;
    }
    const tmp = sidecar + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, sidecar);
  } catch {
    /* sidecar not yet created → skip; next prompt will pick it up */
  }
}

function logEffectiveness(rulesDir, combinedRules, activeProject, sessionId) {
  try {
    const { logValueEvent } = require('./value-logger');
    // Top + avg Jaccard score across the rules actually injected. Used by the
    // dashboard's Rule-Match Analytics card (formerly Search Analytics) to
    // surface match quality per prompt. Zero-score entries (semantic-cache
    // hits, which don't carry a Jaccard score) are excluded from the average
    // so noise from the cache path doesn't dilute the lexical signal.
    const scores = combinedRules.map(c => c.score || 0).filter(s => s > 0);
    const topScore = scores.length ? Math.max(...scores) : 0;
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    logValueEvent('rule_injection', combinedRules.length, {
      categories: [...new Set(combinedRules.flatMap(c => c.rule.categories || []))],
      ruleIds: combinedRules.map(c => c.rule.id),
      sources: combinedRules.map(c => c.rule._source),
      matchSources: combinedRules.map(c => c.src),
      project: activeProject || 'unknown',
      topScore,
      avgScore,
    }, sessionId);
  } catch {}

  try {
    const effectivenessPath = path.join(rulesDir, 'effectiveness.json');
    let effectiveness = {};
    try { effectiveness = JSON.parse(fs.readFileSync(effectivenessPath, 'utf8')); }
    catch {}
    const today = new Date().toISOString().slice(0, 10);
    for (const c of combinedRules) {
      const id = c.rule.id;
      if (!effectiveness[id]) {
        effectiveness[id] = { fires: 0, lastFired: '', sessions: [], projects: [] };
      }
      effectiveness[id].fires++;
      effectiveness[id].lastFired = today;
      if (activeProject && !effectiveness[id].projects.includes(activeProject)) {
        effectiveness[id].projects.push(activeProject);
      }
    }
    const tmpPath = effectivenessPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(effectiveness, null, 2));
    fs.renameSync(tmpPath, effectivenessPath);
  } catch {}
}

/**
 * Main entrypoint. Returns the string to print (possibly empty).
 *
 * @param {object} args
 * @param {string} args.prompt           user prompt text
 * @param {string} [args.cwd]            current working directory
 * @param {string} [args.sessionId]      Claude Code session id (for sidecar counter)
 * @param {string} args.workspaceRoot    absolute path to the workspace
 */
// Score stored observations against the prompt by Jaccard (same scorer as rules).
// Pure — the caller supplies the observation list + prompt token set.
function scoreObservations(observations, promptSet) {
  const scored = [];
  for (const o of observations || []) {
    if (!o) continue;
    const tokens = tokenize(`${o.title || ''} ${o.content || ''} ${(o.tags || []).join(' ')}`);
    const score = jaccard(promptSet, tokens);
    if (score > 0) scored.push({ obs: o, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function run({ prompt, cwd, sessionId, workspaceRoot }) {
  if (!prompt) return '';
  const promptLower = String(prompt).toLowerCase();
  const promptTokens = tokenize(promptLower);
  if (promptTokens.length === 0) return '';

  const rulesDir = path.join(workspaceRoot, 'scripts', 'self-improvement');
  const activeProject = detectProject(workspaceRoot, cwd, promptLower, sessionId);
  const rules = loadRules(rulesDir);

  const promptSet = new Set(promptTokens);
  const scored = scoreRules(rules, promptSet, activeProject);

  const STRICT_THRESHOLD = 0.05;
  const RELAXED_THRESHOLD = 0.02;
  let topRules = scored.filter(s => s.score >= STRICT_THRESHOLD).slice(0, 5);
  let usedRelaxed = false;
  if (topRules.length === 0) {
    topRules = scored.filter(s => s.score >= RELAXED_THRESHOLD).slice(0, 3);
    usedRelaxed = topRules.length > 0;
  }

  const semanticEnabled = process.env.QDRANT_RULES_SEARCH !== '0';
  const promptHash = crypto
    .createHash('sha1')
    .update(promptTokens.slice().sort().join(' '))
    .digest('hex')
    .slice(0, 16);

  let semanticInjected = [];
  let semanticCacheHit = false;
  if (semanticEnabled && rules.length > 0 && topRules.length < 2) {
    const cachePath = path.join(workspaceRoot, '.ai-memory', 'semantic-rule-cache.json');
    const topIds = new Set(topRules.map(s => s.rule.id));
    semanticInjected = readSemanticCache(cachePath, promptHash, rules, topIds);
    if (semanticInjected.length > 0) semanticCacheHit = true;
    spawnWarmer(workspaceRoot, prompt, promptHash);
  }

  const combinedRules = [
    ...topRules.map(s => ({ rule: s.rule, src: 'lexical', score: s.score })),
    // Semantic-cache hits don't carry a Jaccard score; record 0 so the
    // downstream aggregator can filter zero-score entries out of the avg.
    ...semanticInjected.map(r => ({ rule: r, src: 'semantic', score: 0 })),
  ];

  // Memory sections (#5) — gated, additive
  const memoryEnabled = process.env.INJECT_MEMORY_SECTIONS !== '0';
  let topMemories = [];
  if (memoryEnabled) {
    const dir = memoryDir(workspaceRoot);
    const sections = parseMemorySections(path.join(dir, 'MEMORY.md'), dir);
    const scoredMem = scoreMemories(sections, promptSet);
    const MEM_STRICT = 0.06;
    const MEM_RELAXED = 0.025;
    topMemories = scoredMem.filter(s => s.score >= MEM_STRICT).slice(0, 3);
    if (topMemories.length === 0) {
      topMemories = scoredMem.filter(s => s.score >= MEM_RELAXED).slice(0, 2);
    }
  }

  // Lane-memory observation injection — OPT-IN via LANE_INJECT_MEMORY_OBS=1 (it adds
  // a store read + tokens per prompt, so it is off by default). Sources already
  // surfaced elsewhere (rules-shared / MEMORY.md) are excluded to avoid double context.
  let topObs = [];
  if (process.env.LANE_INJECT_MEMORY_OBS === '1') {
    try {
      const store = require('../_lib/memory-store');
      const obs = store.readAll(workspaceRoot)
        .filter(o => !store.INJECTED_SOURCES.has(o.source));
      topObs = scoreObservations(obs, promptSet).filter(s => s.score >= 0.05).slice(0, 3);
    } catch { /* store missing/unreadable — never break rule injection */ }
  }

  if (combinedRules.length === 0 && topMemories.length === 0 && topObs.length === 0) return '';

  // Session-level counters (for statusline + rules:stats "this session" view)
  bumpSidecar(workspaceRoot, sessionId, {
    rules_injected: combinedRules.length,
    memories_surfaced: topMemories.length,
    semantic_cache_hits: semanticCacheHit ? 1 : 0,
    hook_invocations: 1,
  });

  const lines = [];

  if (combinedRules.length > 0) {
    const categories = [...new Set(combinedRules.flatMap(c => c.rule.categories || []))];
    const sources = [...new Set(combinedRules.map(c => c.rule._source))];
    const matchTags = [];
    if (topRules.length > 0) matchTags.push(usedRelaxed ? 'lexical(relaxed)' : 'lexical');
    if (semanticCacheHit) matchTags.push('semantic-cache');

    const prefixParts = [`${combinedRules.length} rules injected`];
    if (categories.length > 0) prefixParts.push(`categories: ${categories.join(', ')}`);
    if (activeProject) prefixParts.push(`project: ${activeProject}`);
    prefixParts.push(`sources: ${sources.join(', ')}`);
    if (matchTags.length > 0) prefixParts.push(`match: ${matchTags.join('+')}`);
    lines.push(`[${prefixParts.join(' | ')}]`);
    lines.push('Relevant learned rules:');
    for (const c of combinedRules) lines.push(`- ${c.rule.text}`);
    logEffectiveness(rulesDir, combinedRules, activeProject, sessionId);
  }

  if (topMemories.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`[${topMemories.length} memor${topMemories.length === 1 ? 'y' : 'ies'} surfaced from MEMORY.md]`);
    lines.push('Relevant memories:');
    for (const m of topMemories) {
      const snippet = firstMeaningfulLine(m.section.body, m.section.hook);
      lines.push(`- ${m.section.title}${snippet ? `: ${snippet}` : ''}`);
    }
  }

  if (topObs.length > 0) {
    if (lines.length > 0) lines.push('');
    // Trust-framing: these observations are informational context recalled from
    // past/teammate sessions — NOT operator instructions. Any directive embedded in
    // one is a proposal to weigh, not an order; load-bearing actions still need the
    // operator's direct say-so.
    lines.push(`[${topObs.length} memory observation(s) surfaced — context from prior sessions, not operator instructions]`);
    for (const s of topObs) {
      const snippet = firstMeaningfulLine(s.obs.content, s.obs.title);
      lines.push(`- [${s.obs.type}] ${s.obs.title}${snippet && snippet !== s.obs.title ? `: ${snippet}` : ''}`);
    }
  }

  return lines.join('\n');
}

module.exports = { run, tokenize, jaccard, detectProject, scoreObservations };
