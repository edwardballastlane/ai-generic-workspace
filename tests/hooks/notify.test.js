'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'notify.js');

async function setupRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'notify-'));
}

function runHook(root, stdinPayload) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: stdinPayload,
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_ROOT: root }
  });
}

async function readEvents(root) {
  const p = path.join(root, '.claude', 'logs', 'notifications.jsonl');
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}

test('AC-17: full payload appends JSONL with all keys', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({
      session_id: 'abc',
      level: 'warning',
      message: 'hello'
    }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const raw = await readEvents(root);
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.type, 'notification');
    assert.equal(ev.session_id, 'abc');
    assert.equal(ev.level, 'warning');
    assert.equal(ev.message, 'hello');
    assert.equal(ev.source, 'claude-code');
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-18a: empty stdin → no append, exits 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, '');
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const raw = await readEvents(root);
    assert.equal(raw, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-18b: malformed JSON → no append, exits 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, 'not json');
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const raw = await readEvents(root);
    assert.equal(raw, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('level field round-trips and defaults to "info" when absent', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({
      session_id: 'sid-1',
      message: 'no level here'
    }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const raw = await readEvents(root);
    const ev = JSON.parse(raw.trim());
    assert.equal(ev.level, 'info');
    assert.equal(ev.message, 'no level here');
    assert.equal(ev.session_id, 'sid-1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falls back to .text when .message is absent', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, JSON.stringify({
      session_id: 'sid-2',
      level: 'error',
      text: 'fallback text'
    }));
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const raw = await readEvents(root);
    const ev = JSON.parse(raw.trim());
    assert.equal(ev.message, 'fallback text');
    assert.equal(ev.level, 'error');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
