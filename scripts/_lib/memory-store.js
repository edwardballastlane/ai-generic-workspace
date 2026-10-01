'use strict';

/**
 * memory-store — typed-observation memory for Lane's agent-callable memory MCP
 * server: live, agent-written, TYPED observations, scoped per project.
 *
 * Deliberately dependency-free with KEYWORD ranking (term overlap, title-weighted)
 * — equivalent to an FTS5/BM25 backend for this corpus size — and the `rank`
 * function is injectable so a semantic/hybrid ranker (Lane already has bge-small
 * embeddings) can be swapped in later without touching the server or the schema.
 *
 * Storage: append-only JSONL at .ai-memory/observations/<scope>.jsonl. Scopes:
 * 'project' (team, exportable), 'local' (private), 'user' (cross-workspace).
 * Kept local by default; team-sharing is a separate export step. Pure w.r.t. an
 * injected `root` so it unit-tests against a tempdir with no globals.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Observation taxonomy. */
const OBS_TYPES = [
  'decision', 'bugfix', 'architecture', 'pattern', 'config',
  'discovery', 'preference', 'feature', 'session_summary',
];
const DEFAULT_TYPE = 'discovery';
const SCOPES = ['project', 'local', 'user'];
const DEFAULT_SCOPE = 'project';

// Sources that are ALREADY surfaced to the agent by other channels (the prompt
// hook injects rules-shared rules + MEMORY.md sections every turn). Migrated copies
// of them live in the store for completeness, but mem_search / mem_context exclude
// them by default so the agent never sees the same item from two channels in one
// context. Pass includeInjected:true to override.
const INJECTED_SOURCES = new Set(['rules-shared', 'MEMORY.md']);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'this', 'that', 'it', 'as', 'at', 'by',
  'from', 'we', 'you', 'i', 'not', 'so', 'if', 'then', 'than', 'when', 'how',
]);

function scopeFile(root, scope) {
  return path.join(root, '.ai-memory', 'observations', `${scope}.jsonl`);
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Read all observations from the given scopes (missing files → skipped, bad lines → dropped). */
function readAll(root, scopes = SCOPES) {
  const byId = new Map(); // last-write-wins by id
  for (const scope of scopes) {
    const file = scopeFile(root, scope);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.id) byId.set(o.id, o);
      } catch { /* skip malformed */ }
    }
  }
  return [...byId.values()];
}

/** Normalize a partial observation into the full schema. `now`/`id` injectable for tests. */
function normalize(obs, { now, id } = {}) {
  const type = OBS_TYPES.includes(obs.type) ? obs.type : DEFAULT_TYPE;
  const scope = SCOPES.includes(obs.scope) ? obs.scope : DEFAULT_SCOPE;
  const ts = obs.ts || now || new Date().toISOString();
  return {
    id: obs.id || id || `obs_${crypto.randomUUID()}`,
    ts,
    sessionId: obs.sessionId || '',
    scope,
    type,
    title: String(obs.title || '').slice(0, 200),
    content: String(obs.content || ''),
    tags: Array.isArray(obs.tags) ? obs.tags.map(String) : [],
    project: String(obs.project || ''),
    source: obs.source || 'agent',
    // Bi-temporal + supersession (Zep/Graphiti). valid_to === null means
    // "currently true"; a superseded observation gets valid_to set + superseded_by
    // pointing at the record that replaced it. Legacy records lack these keys and are
    // treated as valid (valid_to falsy) by every retrieval filter. See memory-consolidate.js.
    valid_from: obs.valid_from || ts,
    valid_to: obs.valid_to || null,
    superseded_by: obs.superseded_by || '',
    revision: Number.isFinite(obs.revision) ? obs.revision : 0,
    // Provenance: true = authored on THIS machine (mem_save / session summary) and
    // therefore exportable to the team; false = migrated from a shared KB or imported
    // from a teammate's chunk (searchable locally, but not re-exported — avoids chunks
    // cross-contaminating each other). See scripts/memory-export.js.
    local: obs.local === true,
  };
}


/** Token bag for an observation, with the title counted twice (a light field boost). */
function docTokensOf(obs) {
  const title = tokenize(obs.title);
  const body = [...tokenize(obs.content), ...tokenize((obs.tags || []).join(' ')), ...tokenize(obs.type)];
  return [...title, ...title, ...body];
}

/**
 * BM25 ranking over the candidate set (Okapi BM25, k1=1.5, b=0.75). Unlike raw term
 * overlap this weights rare terms (IDF) and normalizes for document length, so a short
 * precisely-matching note beats a long one that merely mentions the term. Pure.
 * @returns {Array<{obs, score}>} unsorted, score > 0 only.
 */
function bm25Rank(rows, terms, { k1 = 1.5, b = 0.75 } = {}) {
  const N = rows.length;
  if (!N || !terms.length) return [];
  const df = new Map();
  const docs = rows.map((o) => docTokensOf(o));
  for (const tokens of docs) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const qset = [...new Set(terms)];
  const out = [];
  for (let i = 0; i < N; i++) {
    const tokens = docs[i];
    const len = tokens.length;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qset) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(q) + 0.5) / (df.get(q) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgdl)));
    }
    if (score > 0) out.push({ obs: rows[i], score });
  }
  return out;
}

/** Cosine of two equal-length numeric vectors (0 if either is zero/empty). */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Hybrid rerank: take BM25-scored candidates and blend in semantic cosine similarity
 * (query vs each observation) — 50/50 on min-max-normalized scores. `embed` is INJECTED
 * (text → number[]), so this is pure + testable with a fake embedder, and the heavy
 * embedding model never has to load in the default path. Only the top `k` BM25 hits are
 * embedded, bounding cost. Enable by passing opts.embed to searchObservations.
 */
function semanticRerank(scored, query, embed, { k = 20 } = {}) {
  if (!scored.length || typeof embed !== 'function') return scored;
  const head = scored.slice().sort((a, b) => b.score - a.score).slice(0, k);
  let qv;
  try { qv = embed(query); } catch { return scored; }
  const maxBm = Math.max(...head.map((r) => r.score)) || 1;
  const sims = head.map((r) => {
    let v; try { v = embed(`${r.obs.title}\n${r.obs.content}`); } catch { v = null; }
    return cosine(qv, v);
  });
  const maxSim = Math.max(...sims, 1e-9);
  return head.map((r, i) => ({ obs: r.obs, score: 0.5 * (r.score / maxBm) + 0.5 * (sims[i] / maxSim) }));
}

/**
 * Save (append) an observation. Idempotent by id: if the id already exists in the
 * scope, it is NOT duplicated (used for re-runnable migration). Returns the stored obs.
 */
function saveObservation(root, obs, opts = {}) {
  const full = normalize(obs, opts);
  const file = scopeFile(root, full.scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const all = readAll(root, [full.scope]);
  if (all.some((o) => o.id === full.id)) return full; // idempotent by id

  // Write-time consolidation gate. Opt out with {consolidate:false}
  // (migration replays history verbatim and must not collapse it).
  if (opts.consolidate !== false) {
    const { decideWrite } = require('./memory-consolidate');
    const decision = decideWrite(full, all);
    if (decision.action === 'noop') {
      return all.find((o) => o.id === decision.targetId) || full; // redundant → don't append
    }
    if (decision.action === 'supersede') {
      full.revision = decision.revision;
      const old = all.find((o) => o.id === decision.targetId);
      if (old) {
        // Close the old record (bi-temporal): last-write-wins by id supersedes the
        // still-open copy on read; history is preserved (both lines stay on disk).
        const closed = { ...old, valid_to: full.ts, superseded_by: full.id };
        fs.appendFileSync(file, JSON.stringify(closed) + '\n');
      }
    }
  }

  fs.appendFileSync(file, JSON.stringify(full) + '\n');
  return full;
}

/**
 * Insert-or-overwrite an observation. Unlike saveObservation (idempotent — skips if
 * the id already exists), this ALWAYS appends the normalized record; because readAll
 * is last-write-wins by id, the appended copy supersedes any earlier one with the same
 * id. Used to replace a thin session-stop summary with a richer PR-time one under a
 * deterministic id. The superseded line is harmless (deduped on read; consolidated later).
 */
function upsertObservation(root, obs, opts = {}) {
  const full = normalize(obs, opts);
  const file = scopeFile(root, full.scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(full) + '\n');
  return full;
}

/** Search observations by keyword, optionally filtered by scope/type/project. */
function searchObservations(root, query, opts = {}) {
  const { scope, type, project, limit = 5, includeInjected = false, includeSuperseded = false, embed, ranker } = opts;
  const scopes = scope ? [scope] : SCOPES;
  const terms = tokenize(query);
  let rows = readAll(root, scopes);
  if (!includeInjected) rows = rows.filter((o) => !INJECTED_SOURCES.has(o.source));
  if (!includeSuperseded) rows = rows.filter((o) => !o.valid_to);   // only currently-valid
  if (type) rows = rows.filter((o) => o.type === type);
  if (project) rows = rows.filter((o) => o.project === project);

  // Default ranker: BM25. `ranker(rows, terms) => [{obs, score}]` overrides it;
  // `embed` (text → vector) turns on hybrid semantic rerank of the top BM25 hits.
  let scored = (typeof ranker === 'function' ? ranker : bm25Rank)(rows, terms);
  if (embed) scored = semanticRerank(scored, query, embed);

  return scored
    .sort((a, b) => (b.score - a.score) || String(b.obs.ts).localeCompare(String(a.obs.ts)))
    .slice(0, limit)
    .map((r) => ({ ...r.obs, _score: r.score }));
}

/**
 * Semantic search: take the BM25 top-K candidates, embed the query
 * + each candidate, and re-rank by cosine similarity. Bounds embedding cost to the
 * candidate set. `opts.embedBatch` (async texts→vectors) is INJECTED — real usage wires
 * the local bge-small embedder; tests pass a fake. Falls back to the BM25 ordering if
 * embedding fails, so a missing model never breaks search.
 * @returns {Promise<Array>}
 */
async function searchObservationsSemantic(root, query, opts = {}) {
  const { limit = 5, candidateK = 30 } = opts;
  const bm25 = searchObservations(root, query, { ...opts, limit: candidateK });
  if (bm25.length <= 1) return bm25.slice(0, limit);
  const embedBatch = opts.embedBatch || ((texts) => require('./memory-embed').embedBatch(texts));
  let vecs;
  try {
    vecs = await embedBatch([query, ...bm25.map((o) => `${o.title}\n${o.content}`)]);
  } catch {
    return bm25.slice(0, limit); // embedder unavailable → keep BM25 order
  }
  const qv = vecs[0];
  return bm25
    .map((o, i) => ({ o, sim: cosine(qv, vecs[i + 1]) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((s) => ({ ...s.o, _semscore: s.sim }));
}

/** Fetch one full (untruncated) observation by id across scopes. */
function getObservation(root, id) {
  return readAll(root).find((o) => o.id === id) || null;
}

/** Most-recent observations (for mem_context at session start), newest first. */
function recentContext(root, opts = {}) {
  const { project, limit = 10, scope, includeInjected = false, includeSuperseded = false } = opts;
  let rows = readAll(root, scope ? [scope] : SCOPES);
  if (!includeInjected) rows = rows.filter((o) => !INJECTED_SOURCES.has(o.source));
  if (!includeSuperseded) rows = rows.filter((o) => !o.valid_to);   // only currently-valid
  if (project) rows = rows.filter((o) => o.project === project);
  return rows
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, limit);
}

/** All observations for a session (for mem_session_summary review). */
function sessionObservations(root, sessionId) {
  return readAll(root)
    .filter((o) => o.sessionId && o.sessionId === sessionId)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

module.exports = {
  OBS_TYPES, SCOPES, DEFAULT_TYPE, DEFAULT_SCOPE, STOPWORDS, INJECTED_SOURCES,
  scopeFile, tokenize, readAll, normalize,
  docTokensOf, bm25Rank, cosine, semanticRerank,
  saveObservation, upsertObservation, searchObservations, searchObservationsSemantic, getObservation, recentContext, sessionObservations,
};
