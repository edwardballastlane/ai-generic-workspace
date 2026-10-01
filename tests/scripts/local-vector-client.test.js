'use strict';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Build a temp workspace with a tiny 3-dim vector store fixture, then point the
// local client at it via WORKSPACE_ROOT (read by VectorStoreManager + the client).
async function setup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvc-'));
  fs.mkdirSync(path.join(root, '.claude', 'vector-store'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'visualizations'), { recursive: true });
  const store = {
    entries: [
      { id: 's1-0', session_id: 's1', chunk_text: 'auto commit', embedding: [1, 0, 0], metadata: { date: '2026-06-01', chunk_index: 0, quality_score: 9 } },
      { id: 's1-1', session_id: 's1', chunk_text: 'git push', embedding: [0.9, 0.1, 0], metadata: { date: '2026-06-01', chunk_index: 1, quality_score: 3 } },
      { id: 's2-0', session_id: 's2', chunk_text: 'unrelated', embedding: [0, 0, 1], metadata: { date: '2026-06-02', chunk_index: 0, quality_score: 8 } },
    ],
    metadata: { model: 'test', dimensions: 3, total_sessions: 2, total_chunks: 3, created: '', updated: '' },
  };
  fs.writeFileSync(path.join(root, '.claude', 'vector-store', 'sessions.json'), JSON.stringify(store));
  return root;
}

// Load the client fresh with a given WORKSPACE_ROOT (resets its store singleton).
function freshClient(root) {
  process.env.WORKSPACE_ROOT = root;
  process.env.VECTOR_BACKEND = 'local';
  const p = path.join(__dirname, '..', '..', 'scripts', 'self-improvement', 'local-vector-client.ts');
  const vsp = path.join(__dirname, '..', '..', 'scripts', 'session-embedder', 'vector-store.ts');
  delete require.cache[require.resolve(p)];
  delete require.cache[require.resolve(vsp)];
  return require(p);
}

test('scrollSessions filters by session_id match', async () => {
  const root = await setup();
  try {
    const c = freshClient(root);
    const rows = await c.scrollSessions({ must: [{ key: 'session_id', match: { value: 's1' } }] }, 100);
    assert.equal(rows.length, 2, 'only s1 chunks');
    assert.ok(rows.every(r => r.payload.session_id === 's1'));
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('scrollSessions filters by quality_score range (gte)', async () => {
  const root = await setup();
  try {
    const c = freshClient(root);
    const rows = await c.scrollSessions({ must: [{ key: 'quality_score', range: { gte: 8 } }] }, 100);
    assert.equal(rows.length, 2, 'only chunks with quality >= 8 (s1-0=9, s2-0=8)');
    assert.ok(rows.every(r => r.payload.quality_score >= 8));
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('searchSessions applies the quality min filter', async () => {
  const root = await setup();
  try {
    const c = freshClient(root);
    // query closest to s1 vectors; min:8 must exclude s1-1 (quality 3)
    const res = await c.searchSessions([1, 0, 0], 10, { min: 8 });
    assert.ok(res.length >= 1);
    assert.ok(res.every(r => r.payload.quality_score >= 8), 'no sub-8 chunks returned');
    assert.ok(!res.some(r => r.payload.id === 's1-1'), 's1-1 (q=3) filtered out');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('storeReflection appends a record that getReflectionStats counts', async () => {
  const root = await setup();
  try {
    const c = freshClient(root);
    assert.equal((await c.getReflectionStats()).count, 0);
    await c.storeReflection('r1', [0, 0, 0], {
      failure_type: 'X', failure_description: 'd', root_cause: 'rc', prevention_rule: 'pr', session_id: 's1',
    });
    assert.equal((await c.getReflectionStats()).count, 1);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('dead rules-collection ops are safe no-ops', async () => {
  const root = await setup();
  try {
    const c = freshClient(root);
    await c.storeRule(); await c.deleteRulesBatch(['x']);
    assert.equal(await c.syncAllRules([{ id: 'a', embedding: [], payload: {} }]), 1);
    assert.equal(typeof (await c.getRuleStats()).count, 'number');
    assert.deepEqual(await c.searchRules(), []);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
