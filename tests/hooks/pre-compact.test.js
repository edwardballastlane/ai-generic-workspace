'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-compact.js');

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-'));
  // findWorkspaceRoot walks up looking for CLAUDE.md; pin via env var instead.
  await fs.mkdir(path.join(root, '.ai-session', 'by-id'), { recursive: true });
  await fs.mkdir(path.join(root, '.ai-session', 'resume'), { recursive: true });
  return root;
}

function runHook(root, hookInput) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: hookInput == null ? '' : JSON.stringify(hookInput),
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_ROOT: root },
  });
}

async function listSnapshots(root) {
  const dir = path.join(root, '.ai-session', 'resume');
  let entries = [];
  try { entries = await fs.readdir(dir); } catch {}
  return entries.filter((n) => n.endsWith('.md') && n !== 'latest.md');
}

test('AC-16: snapshot written with pre-compact note on happy path', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, { session_id: 'abc-123', trigger: 'manual' });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.equal(r.stdout, '', 'hook must be silent');

    const snapshots = await listSnapshots(root);
    assert.equal(snapshots.length, 1, `expected 1 snapshot, got ${snapshots.join(',')}`);

    const body = await fs.readFile(
      path.join(root, '.ai-session', 'resume', snapshots[0]),
      'utf8'
    );
    assert.match(body, /pre-compact \(manual\) — auto-saved before context compaction/);

    // latest.md is a plain copy mirroring the snapshot (per impl AC-1).
    const latest = await fs.readFile(
      path.join(root, '.ai-session', 'resume', 'latest.md'),
      'utf8'
    );
    assert.equal(latest, body);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-16: session_id resolves sidecar and derives snapshot prefix', async () => {
  const root = await setupRoot();
  try {
    const sessionId = 'deadbeef-cafe-1234-5678-9abcdef01234';
    // resolveSidecar() in fresh-context-impl matches sessionId only when a
    // sidecar JSON exists; without it, the prefix falls back to "adhoc".
    await fs.writeFile(
      path.join(root, '.ai-session', 'by-id', `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, project: 'test' })
    );

    const r = runHook(root, { session_id: sessionId, trigger: 'auto' });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);

    const snapshots = await listSnapshots(root);
    assert.equal(snapshots.length, 1);
    // fresh-context-impl uses sessionId.slice(0, 8) as the filename prefix.
    assert.ok(
      snapshots[0].startsWith(sessionId.slice(0, 8) + '-'),
      `snapshot ${snapshots[0]} should start with ${sessionId.slice(0, 8)}-`
    );

    const body = await fs.readFile(
      path.join(root, '.ai-session', 'resume', snapshots[0]),
      'utf8'
    );
    // Session id is recorded in the snapshot body header.
    assert.match(body, new RegExp(sessionId));
    assert.match(body, /pre-compact \(auto\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('empty stdin is a no-op (exit 0, no snapshot)', async () => {
  const root = await setupRoot();
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, WORKSPACE_ROOT: root },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.equal(r.stdout, '');

    const snapshots = await listSnapshots(root);
    assert.equal(snapshots.length, 0, `expected no snapshots, got ${snapshots.join(',')}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing session_id is a no-op', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, { trigger: 'manual' });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const snapshots = await listSnapshots(root);
    assert.equal(snapshots.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('malformed JSON stdin is a no-op (fail-soft)', async () => {
  const root = await setupRoot();
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: 'not-json{',
      encoding: 'utf8',
      env: { ...process.env, WORKSPACE_ROOT: root },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const snapshots = await listSnapshots(root);
    assert.equal(snapshots.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
