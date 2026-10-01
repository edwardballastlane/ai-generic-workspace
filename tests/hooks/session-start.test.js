'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');

async function setupRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sstart-'));
}

function runHook(root, stdinPayload) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: stdinPayload,
    encoding: 'utf8',
    env: { ...process.env }
  });
}

test('AC-12: writes session_id to .ai-session/cc-session-id', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({ session_id: 'test-uuid-1' }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const target = path.join(root, '.ai-session', 'cc-session-id');
    const contents = await fs.readFile(target, 'utf8');
    assert.equal(contents, 'test-uuid-1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-13a: empty session_id → no file written, exits 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({ session_id: '' }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const target = path.join(root, '.ai-session', 'cc-session-id');
    let exists = true;
    try { await fs.access(target); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-13b: malformed JSON → no file written, no throw, exits 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, 'not json');
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const target = path.join(root, '.ai-session', 'cc-session-id');
    let exists = true;
    try { await fs.access(target); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-13c: missing session_id field → no file written, exits 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({ other: 'value' }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const target = path.join(root, '.ai-session', 'cc-session-id');
    let exists = true;
    try { await fs.access(target); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-13d: empty stdin → no file written, exits 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, '');
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const target = path.join(root, '.ai-session', 'cc-session-id');
    let exists = true;
    try { await fs.access(target); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session-start clears .ai-session/detected-project so new sessions do not inherit project cache', async () => {
  // Pre-seed a stale detected-project (simulating a previous CC session that
  // worked in my-portal-web). The new session-start must clear it so
  // inject-context cannot fall back to the cache.
  const root = await setupRoot();
  try {
    const aiSession = path.join(root, '.ai-session');
    await fs.mkdir(aiSession, { recursive: true });
    const detected = path.join(aiSession, 'detected-project');
    await fs.writeFile(detected, 'my-portal-web\n');
    const r = runHook(root, JSON.stringify({ session_id: 'new-cc-session' }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    let still = true;
    try { await fs.access(detected); } catch { still = false; }
    assert.equal(still, false, 'detected-project must be removed on session-start');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── Stale git index.lock cleanup (Cursor gitWorker × session-stop race) ─────

async function makeLock(root, { sizeBytes = 0, ageSeconds = 0 } = {}) {
  const gitDir = path.join(root, '.git');
  await fs.mkdir(gitDir, { recursive: true });
  const lockPath = path.join(gitDir, 'index.lock');
  await fs.writeFile(lockPath, sizeBytes === 0 ? '' : 'x'.repeat(sizeBytes));
  if (ageSeconds > 0) {
    const past = (Date.now() - ageSeconds * 1000) / 1000;
    await fs.utimes(lockPath, past, past);
  }
  return lockPath;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

test('sweeps orphaned 0-byte index.lock older than 30s', async () => {
  const root = await setupRoot();
  try {
    const lockPath = await makeLock(root, { sizeBytes: 0, ageSeconds: 60 });
    const r = runHook(root, JSON.stringify({ session_id: 'sweep-stale' }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.equal(await exists(lockPath), false, 'stale lock must be removed');
    const log = path.join(root, '.ai-memory', 'stale-lock-cleanup.jsonl');
    assert.equal(await exists(log), true, 'cleanup must be logged');
    const entry = JSON.parse((await fs.readFile(log, 'utf8')).trim());
    assert.equal(entry.cleaned[0].path, '.git/index.lock');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('preserves fresh 0-byte index.lock (might be in-flight git op)', async () => {
  const root = await setupRoot();
  try {
    const lockPath = await makeLock(root, { sizeBytes: 0, ageSeconds: 0 });
    const r = runHook(root, JSON.stringify({ session_id: 'preserve-fresh' }));
    assert.equal(r.status, 0);
    assert.equal(await exists(lockPath), true, 'fresh lock must NOT be removed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('preserves non-empty index.lock regardless of age (real index write in progress)', async () => {
  const root = await setupRoot();
  try {
    const lockPath = await makeLock(root, { sizeBytes: 128, ageSeconds: 3600 });
    const r = runHook(root, JSON.stringify({ session_id: 'preserve-nonempty' }));
    assert.equal(r.status, 0);
    assert.equal(await exists(lockPath), true, 'non-empty lock must NEVER be removed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('no .git/index.lock → no-op, no cleanup log written', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({ session_id: 'no-lock' }));
    assert.equal(r.status, 0);
    const log = path.join(root, '.ai-memory', 'stale-lock-cleanup.jsonl');
    assert.equal(await exists(log), false, 'log must not be created when nothing was cleaned');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('session-start is a no-op on detected-project when the file does not exist (no spurious error)', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({ session_id: 'fresh-session' }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const detected = path.join(root, '.ai-session', 'detected-project');
    let exists = true;
    try { await fs.access(detected); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Team memory auto-import ----------------------------------------------------

const { refreshManifest } = require('../../scripts/memory-export');

const TEAMMATE_OBS = {
  id: 'obs_team_1', ts: '2026-09-01T00:00:00Z', sessionId: '', scope: 'project',
  type: 'decision', title: 'Use BM25 for memory recall',
  content: 'Chosen over naive substring match.', tags: [], project: '', source: 'agent',
  valid_from: '2026-09-01T00:00:00Z', valid_to: null, superseded_by: '', revision: 0,
  local: true,
};

async function seedTeammateChunk(root, obs = TEAMMATE_OBS) {
  const exp = path.join(root, '.ai-memory', 'observations-export');
  await fs.mkdir(exp, { recursive: true });
  await fs.writeFile(path.join(exp, 'teammate.jsonl'), JSON.stringify(obs) + '\n');
  refreshManifest(root);
}

function livePath(root) {
  return path.join(root, '.ai-memory', 'observations', 'project.jsonl');
}

test('imports a teammate chunk into the live store, marked non-local', async () => {
  const root = await setupRoot();
  try {
    await seedTeammateChunk(root);
    const r = runHook(root, JSON.stringify({ session_id: 'imp-1', cwd: root }));
    assert.equal(r.status, 0);

    const imported = JSON.parse((await fs.readFile(livePath(root), 'utf8')).trim());
    assert.equal(imported.title, 'Use BM25 for memory recall');
    assert.equal(imported.local, false, 'imported observations are never re-exported');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a second session start with unchanged chunks is a no-op', async () => {
  const root = await setupRoot();
  try {
    await seedTeammateChunk(root);
    runHook(root, JSON.stringify({ session_id: 'imp-1', cwd: root }));
    const after1 = await fs.readFile(livePath(root), 'utf8');

    runHook(root, JSON.stringify({ session_id: 'imp-2', cwd: root }));
    assert.equal(await fs.readFile(livePath(root), 'utf8'), after1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a changed chunk is re-imported on the next session start', async () => {
  const root = await setupRoot();
  try {
    await seedTeammateChunk(root);
    runHook(root, JSON.stringify({ session_id: 'imp-1', cwd: root }));

    await seedTeammateChunk(root, { ...TEAMMATE_OBS, id: 'obs_team_2', title: 'Second decision' });
    runHook(root, JSON.stringify({ session_id: 'imp-2', cwd: root }));

    const lines = (await fs.readFile(livePath(root), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'both observations land in the live store');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session start succeeds when there is nothing to import', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({ session_id: 'imp-empty', cwd: root }));
    assert.equal(r.status, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
