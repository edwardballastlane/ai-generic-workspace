'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../../scripts/_lib/memory-store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-'));
}

test('normalize fills id/ts and clamps type/scope to defaults', () => {
  const o = store.normalize({ title: 't', content: 'c', type: 'bogus', scope: 'bogus' }, { now: '2026-01-01T00:00:00Z', id: 'x' });
  assert.equal(o.id, 'x');
  assert.equal(o.ts, '2026-01-01T00:00:00Z');
  assert.equal(o.type, store.DEFAULT_TYPE);
  assert.equal(o.scope, store.DEFAULT_SCOPE);
  assert.deepEqual(o.tags, []);
});

test('save + readAll round-trips', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'a', content: 'hello', type: 'decision' }, { id: 'i1' });
  const all = store.readAll(root, ['project']);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'i1');
  assert.equal(all[0].type, 'decision');
});

test('save is idempotent by id (no duplicates on re-run)', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'a', content: 'x' }, { id: 'dup' });
  store.saveObservation(root, { title: 'a-again', content: 'y' }, { id: 'dup' });
  const all = store.readAll(root, ['project']);
  assert.equal(all.length, 1);
});

test('search ranks title matches above body matches', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'cache invalidation', content: 'misc' }, { id: 'titlehit' });
  store.saveObservation(root, { title: 'misc', content: 'about cache somewhere' }, { id: 'bodyhit' });
  const res = store.searchObservations(root, 'cache', { scope: 'project' });
  assert.equal(res[0].id, 'titlehit');
  assert.equal(res.length, 2);
});

test('search filters by type and project', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'x auth', content: 'a', type: 'bugfix', project: 'p1' }, { id: 'b1' });
  store.saveObservation(root, { title: 'x auth', content: 'a', type: 'decision', project: 'p2' }, { id: 'd1' });
  assert.deepEqual(store.searchObservations(root, 'auth', { type: 'bugfix' }).map((o) => o.id), ['b1']);
  assert.deepEqual(store.searchObservations(root, 'auth', { project: 'p2' }).map((o) => o.id), ['d1']);
});

test('search returns nothing for a query with no term overlap', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'alpha', content: 'beta' }, { id: 'z' });
  assert.deepEqual(store.searchObservations(root, 'zzzznomatch'), []);
});

test('getObservation returns full obs or null', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 't', content: 'full body here' }, { id: 'g1' });
  assert.equal(store.getObservation(root, 'g1').content, 'full body here');
  assert.equal(store.getObservation(root, 'nope'), null);
});

test('recentContext returns newest first, honoring limit', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'old', content: 'c' }, { id: 'o', now: '2026-01-01T00:00:00Z' });
  store.saveObservation(root, { title: 'new', content: 'c' }, { id: 'n', now: '2026-02-01T00:00:00Z' });
  const r = store.recentContext(root, { limit: 1 });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'n');
});

test('sessionObservations filters by sessionId, chronological', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'a', content: 'c', sessionId: 'S1' }, { id: 'a', now: '2026-01-02T00:00:00Z' });
  store.saveObservation(root, { title: 'b', content: 'c', sessionId: 'S1' }, { id: 'b', now: '2026-01-01T00:00:00Z' });
  store.saveObservation(root, { title: 'c', content: 'c', sessionId: 'S2' }, { id: 'c' });
  const r = store.sessionObservations(root, 'S1');
  assert.deepEqual(r.map((o) => o.id), ['b', 'a']);
});

test('bm25Rank: rare-term match outranks common-term match (IDF)', () => {
  // "the" is common across all docs (low IDF); "kubernetes" is rare (high IDF).
  const rows = [
    { title: 'the the the', content: 'the the', type: 'discovery', tags: [] },
    { title: 'kubernetes pod', content: 'about kubernetes', type: 'discovery', tags: [] },
    { title: 'the common thing', content: 'the the the', type: 'discovery', tags: [] },
  ];
  const scored = store.bm25Rank(rows, store.tokenize('kubernetes'));
  assert.equal(scored.length, 1);
  assert.equal(scored[0].obs.title, 'kubernetes pod');
});

test('bm25Rank: length normalization favors the concise match', () => {
  const rows = [
    { title: 'cache', content: 'cache', type: 'x', tags: [] },
    { title: 'cache', content: 'cache ' + 'filler '.repeat(80), type: 'x', tags: [] },
  ];
  const scored = store.bm25Rank(rows, store.tokenize('cache')).sort((a, b) => b.score - a.score);
  assert.equal(scored[0].obs.content, 'cache', 'the short doc wins');
});

test('search still ranks a title match above a body-only match (via BM25)', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'cache invalidation', content: 'misc' }, { id: 'titlehit' });
  store.saveObservation(root, { title: 'misc note', content: 'about cache somewhere here' }, { id: 'bodyhit' });
  assert.equal(store.searchObservations(root, 'cache', { scope: 'project' })[0].id, 'titlehit');
});

test('semanticRerank blends BM25 with injected cosine (pure, fake embedder)', () => {
  // Fake embedder: 1-D vector = keyword presence of "auth".
  const embed = (t) => [/auth/i.test(t) ? 1 : 0];
  const scored = [
    { obs: { title: 'login flow', content: 'session cookie' }, score: 1.0 },   // high BM25, no "auth"
    { obs: { title: 'auth token', content: 'auth refresh' }, score: 0.6 },      // lower BM25, semantic match
  ];
  const reranked = store.semanticRerank(scored, 'auth', embed).sort((a, b) => b.score - a.score);
  assert.equal(reranked[0].obs.title, 'auth token', 'semantic signal lifts the auth doc');
});

test('semanticRerank is a no-op without an embedder', () => {
  const scored = [{ obs: { title: 'a', content: 'b' }, score: 1 }];
  assert.deepEqual(store.semanticRerank(scored, 'q', null), scored);
});

test('cosine handles zero/mismatched vectors safely', () => {
  assert.equal(store.cosine([1, 0], [1, 0]), 1);
  assert.equal(store.cosine([0, 0], [1, 1]), 0);
  assert.equal(store.cosine([1], [1, 2]), 0);
});

test('searchObservationsSemantic reranks BM25 candidates by injected embedder', async () => {
  const root = tmpRoot();
  // "login flow" wins on BM25 for the query token "session"; "auth token" is the
  // semantic match. A fake embedder keys the vector on the word "auth".
  store.saveObservation(root, { title: 'session login flow', content: 'session cookie handling' }, { id: 'bm' });
  store.saveObservation(root, { title: 'auth token', content: 'auth refresh and session' }, { id: 'sem' });
  const embedBatch = async (texts) => texts.map((t) => [/auth/i.test(t) ? 1 : 0]);
  const res = await store.searchObservationsSemantic(root, 'auth session', { embedBatch, candidateK: 30, limit: 5 });
  assert.equal(res[0].id, 'sem', 'semantic match ranked first');
  assert.ok(typeof res[0]._semscore === 'number');
});

test('searchObservationsSemantic falls back to BM25 order if the embedder throws', async () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'alpha widget', content: 'x' }, { id: 'a' });
  store.saveObservation(root, { title: 'alpha gadget', content: 'y' }, { id: 'b' });
  const embedBatch = async () => { throw new Error('no model'); };
  const res = await store.searchObservationsSemantic(root, 'alpha', { embedBatch });
  assert.ok(res.length >= 1, 'still returns BM25 results despite embed failure');
});

test('searchObservationsSemantic returns early for 0/1 candidates', async () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'solo', content: 'only one' }, { id: 'x' });
  let called = false;
  const embedBatch = async (t) => { called = true; return t.map(() => [0]); };
  const res = await store.searchObservationsSemantic(root, 'solo', { embedBatch });
  assert.equal(res.length, 1);
  assert.equal(called, false, 'no embedding needed for a single candidate');
});

test('normalize records local provenance (default false, honors true)', () => {
  assert.equal(store.normalize({ title: 't', content: 'c' }).local, false);
  assert.equal(store.normalize({ title: 't', content: 'c', local: true }).local, true);
  assert.equal(store.normalize({ title: 't', content: 'c', local: 'yes' }).local, false, 'only strict true counts');
});

test('search/context exclude already-injected sources by default (no double context)', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'cache rule', content: 'x', source: 'rules-shared' }, { id: 'r1' });
  store.saveObservation(root, { title: 'cache note', content: 'y', source: 'agent' }, { id: 'a1' });
  // default: the rules-shared (already prompt-injected) copy is hidden
  assert.deepEqual(store.searchObservations(root, 'cache').map((o) => o.id), ['a1']);
  assert.deepEqual(store.recentContext(root, { limit: 10 }).map((o) => o.id), ['a1']);
  // explicit opt-in includes it
  const ids = store.searchObservations(root, 'cache', { includeInjected: true }).map((o) => o.id).sort();
  assert.deepEqual(ids, ['a1', 'r1']);
});

// --- Governance layer: bi-temporal schema (⑫) + consolidation gate (⑪) --------

test('normalize adds bi-temporal defaults (valid_from=ts, valid_to=null, revision=0)', () => {
  const o = store.normalize({ title: 't', content: 'c' }, { now: '2026-05-01T00:00:00Z', id: 'x' });
  assert.equal(o.valid_from, '2026-05-01T00:00:00Z');
  assert.equal(o.valid_to, null);
  assert.equal(o.superseded_by, '');
  assert.equal(o.revision, 0);
});

test('consolidation NOOP: identical re-save does not append', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'Cache bug', content: 'in redis', type: 'bugfix' }, { id: 'a' });
  const ret = store.saveObservation(root, { title: 'cache  bug', content: 'IN redis', type: 'bugfix' }, { id: 'b' });
  const all = store.readAll(root, ['project']);
  assert.equal(all.length, 1, 'redundant write dropped');
  assert.equal(ret.id, 'a', 'returns the existing record');
});

test('consolidation SUPERSEDE: closes old, new is current with revision+1', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'ThemeConfig sites', content: 'two', type: 'discovery' }, { id: 'old', now: '2026-01-01T00:00:00Z' });
  store.saveObservation(root, { title: 'ThemeConfig sites', content: 'actually three', type: 'discovery' }, { id: 'new', now: '2026-02-01T00:00:00Z' });
  const all = store.readAll(root, ['project']);
  const oldRec = all.find((o) => o.id === 'old');
  const newRec = all.find((o) => o.id === 'new');
  assert.equal(oldRec.valid_to, '2026-02-01T00:00:00Z', 'old closed at new ts');
  assert.equal(oldRec.superseded_by, 'new');
  assert.equal(newRec.valid_to, null, 'new is current');
  assert.equal(newRec.revision, 1);
});

test('search + recentContext exclude superseded by default; includeSuperseded opts in', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'widget alpha', content: 'v1', type: 'discovery' }, { id: 'old', now: '2026-01-01T00:00:00Z' });
  store.saveObservation(root, { title: 'widget alpha', content: 'v2', type: 'discovery' }, { id: 'new', now: '2026-02-01T00:00:00Z' });
  assert.deepEqual(store.searchObservations(root, 'widget').map((o) => o.id), ['new']);
  assert.deepEqual(store.recentContext(root, { limit: 10 }).map((o) => o.id), ['new']);
  const withHist = store.searchObservations(root, 'widget', { includeSuperseded: true }).map((o) => o.id).sort();
  assert.deepEqual(withHist, ['new', 'old']);
});

test('consolidate:false replays verbatim (migration preserves history)', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'dup title', content: 'a', type: 'bugfix' }, { id: 'm1' });
  store.saveObservation(root, { title: 'dup title', content: 'b', type: 'bugfix' }, { id: 'm2', consolidate: false });
  const all = store.readAll(root, ['project']);
  assert.equal(all.length, 2);
  assert.ok(all.every((o) => !o.valid_to), 'nothing superseded under consolidate:false');
});

test('readAll skips malformed lines', () => {
  const root = tmpRoot();
  const f = store.scopeFile(root, 'project');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"id":"ok","title":"t"}\nNOT JSON\n\n{"id":"ok2"}\n');
  assert.equal(store.readAll(root, ['project']).length, 2);
});
