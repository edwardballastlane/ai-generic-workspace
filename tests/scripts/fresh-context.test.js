'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'fresh-context.js');

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-ctx-'));
  await fs.mkdir(path.join(root, '.ai-session', 'by-id'), { recursive: true });
  await fs.mkdir(path.join(root, '.ai-session', 'resume'), { recursive: true });
  return root;
}

async function writeSidecar(root, sessionId, overrides = {}) {
  const sidecar = {
    session_id: sessionId,
    project: 'test-project',
    started_at: '2026-05-01T10:00:00Z',
    last_active: '2026-05-01T11:00:00Z',
    cwd: root,
    prompts: 5,
    lessons_captured: [],
    cost_usd: 1.234,
    lines_added: 100,
    lines_removed: 50,
    ...overrides
  };
  const p = path.join(root, '.ai-session', 'by-id', `${sessionId}.json`);
  await fs.writeFile(p, JSON.stringify(sidecar, null, 2));
  return p;
}

function runScript(root, args = [], opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', CLAUDE_SESSION_ID: '' },
    ...opts
  });
}

// ── AC-1: snapshot file written + latest.md is plain file ────────────────────
test('AC-1: writes <shortid>-<ts>.md and latest.md as a plain file', async () => {
  const root = await setupRoot();
  try {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeSidecar(root, sid);

    const r = runScript(root, ['--session-id', sid]);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const resumeDir = path.join(root, '.ai-session', 'resume');
    const entries = await fs.readdir(resumeDir);
    const snapshots = entries.filter(n => n !== 'latest.md' && n.endsWith('.md'));
    assert.equal(snapshots.length, 1, `expected 1 snapshot, got ${snapshots.length}`);
    assert.match(snapshots[0], /^aaaaaaaa-\d{8}-\d{6}\.md$/);

    const latest = path.join(resumeDir, 'latest.md');
    assert.equal(fsSync.lstatSync(latest).isSymbolicLink(), false,
      'latest.md must be a plain file, not a symlink');

    // latest.md content matches the snapshot.
    const a = await fs.readFile(latest, 'utf8');
    const b = await fs.readFile(path.join(resumeDir, snapshots[0]), 'utf8');
    assert.equal(a, b);
    assert.match(a, /Project.*test-project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── AC-1 regression: pre-existing symlink at latest.md is replaced ───────────
// Defense against the original bash version's `ln -sf` leaving a symlink that
// fs.writeFileSync would follow rather than replace.
test('AC-1: replaces pre-existing latest.md symlink with a plain file', async () => {
  const root = await setupRoot();
  try {
    const sid = 'cafef00d-1111-2222-3333-444444444444';
    await writeSidecar(root, sid);

    const resumeDir = path.join(root, '.ai-session', 'resume');
    await fs.mkdir(resumeDir, { recursive: true });

    // Seed a target file and symlink latest.md → target (mirrors bash behavior).
    const seedTarget = path.join(resumeDir, 'cafef00d-19990101-000000.md');
    await fs.writeFile(seedTarget, 'OLD TARGET CONTENT\n');
    fsSync.symlinkSync(path.basename(seedTarget), path.join(resumeDir, 'latest.md'));
    assert.equal(fsSync.lstatSync(path.join(resumeDir, 'latest.md')).isSymbolicLink(),
      true, 'precondition: latest.md is a symlink');

    const r = runScript(root, ['--session-id', sid]);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const latest = path.join(resumeDir, 'latest.md');
    assert.equal(fsSync.lstatSync(latest).isSymbolicLink(), false,
      'latest.md must be replaced with a plain file');

    // Old target file unchanged (the symlink was replaced, not the target written through).
    const oldContent = await fs.readFile(seedTarget, 'utf8');
    assert.equal(oldContent, 'OLD TARGET CONTENT\n',
      'old target must remain unchanged');

    const newLatest = await fs.readFile(latest, 'utf8');
    assert.match(newLatest, /Resume Prompt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── AC-2 (success): --latest cats existing latest.md ──────────────────────────
test('AC-2: --latest prints existing latest.md to stdout', async () => {
  const root = await setupRoot();
  try {
    const latest = path.join(root, '.ai-session', 'resume', 'latest.md');
    await fs.writeFile(latest, '# pre-existing snapshot\nbody\n');
    const r = runScript(root, ['--latest']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pre-existing snapshot/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── AC-2 (failure): --latest with no file ────────────────────────────────────
test('AC-2: --latest exits 1 when no latest.md exists', async () => {
  const root = await setupRoot();
  try {
    const r = runScript(root, ['--latest']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No snapshot exists yet/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── AC-3: --print writes to stdout, no file in resume dir ────────────────────
test('AC-3: --print writes only to stdout', async () => {
  const root = await setupRoot();
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    await writeSidecar(root, sid);

    const r = runScript(root, ['--print', '--session-id', sid]);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.match(r.stdout, /Resume Prompt/);
    assert.match(r.stdout, /test-project/);

    const entries = await fs.readdir(path.join(root, '.ai-session', 'resume'));
    assert.equal(entries.length, 0, `--print must not create files; got ${entries.join(',')}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── AC-4: pruning keeps only 20 most-recent + latest.md ──────────────────────
test('AC-4: pruning keeps 20 most-recent .md files (excluding latest.md)', async () => {
  const root = await setupRoot();
  try {
    const resumeDir = path.join(root, '.ai-session', 'resume');
    // Pre-seed 25 fake snapshots with staggered mtimes (oldest first).
    const baseTime = Date.now() - 100_000_000;
    for (let i = 0; i < 25; i++) {
      const name = `oldsnap-${String(i).padStart(2, '0')}.md`;
      const p = path.join(resumeDir, name);
      await fs.writeFile(p, `seed ${i}\n`);
      const t = (baseTime + i * 60_000) / 1000; // seconds
      fsSync.utimesSync(p, t, t);
    }

    const sid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    await writeSidecar(root, sid);

    const r = runScript(root, ['--session-id', sid]);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const after = await fs.readdir(resumeDir);
    const mds = after.filter(n => n.endsWith('.md') && n !== 'latest.md');
    assert.equal(mds.length, 20, `expected 20 .md after prune, got ${mds.length}`);
    assert.ok(after.includes('latest.md'), 'latest.md must be preserved');

    // The brand-new snapshot is the freshest, so it must survive.
    const newSnap = mds.find(n => n.startsWith('99999999-'));
    assert.ok(newSnap, 'new snapshot must be present after prune');

    // The oldest seeds (00, 01, 02, 03, 04) must be the ones deleted.
    assert.ok(!after.includes('oldsnap-00.md'));
    assert.ok(!after.includes('oldsnap-04.md'));
    assert.ok(after.includes('oldsnap-24.md'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── AC-19: executable bit set after run ──────────────────────────────────────
test('AC-19: script has executable bit set after first run', async () => {
  const root = await setupRoot();
  try {
    const sid = '33333333-4444-5555-6666-777777777777';
    await writeSidecar(root, sid);
    const r = runScript(root, ['--session-id', sid]);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    const mode = fsSync.statSync(SCRIPT).mode;
    // Owner-executable bit must be set (skip on Windows where mode bits differ).
    if (process.platform !== 'win32') {
      assert.ok((mode & 0o111) !== 0, `mode=${mode.toString(8)} missing exec bits`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── inline note positional arg ───────────────────────────────────────────────
test('inline positional note appears in snapshot', async () => {
  const root = await setupRoot();
  try {
    const sid = '44444444-5555-6666-7777-888888888888';
    await writeSidecar(root, sid);
    const r = runScript(root, ['--print', '--session-id', sid, 'debugging auth flow']);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.match(r.stdout, /Note from previous session/);
    assert.match(r.stdout, /debugging auth flow/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── piped stdin note ─────────────────────────────────────────────────────────
test('piped stdin note appears in snapshot', async () => {
  const root = await setupRoot();
  try {
    const sid = '55555555-6666-7777-8888-999999999999';
    await writeSidecar(root, sid);
    const r = runScript(root, ['--print', '--session-id', sid], { input: 'note via stdin' });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.match(r.stdout, /Note from previous session/);
    assert.match(r.stdout, /note via stdin/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── no sidecar present: still produces a snapshot, no crash ──────────────────
test('no sidecar present: snapshot still produced with placeholders', async () => {
  const root = await setupRoot();
  try {
    const r = runScript(root, ['--print']);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.match(r.stdout, /Resume Prompt/);
    // No sidecar → project is "-".
    assert.match(r.stdout, /\*\*Project\*\*: -/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── T1 / AC-16 enabler: in-process require('./fresh-context-impl').run() ─────
// pre-compact.js (T7) calls this entry point; it must produce a snapshot file
// without spawning a child process and without depending on process.cwd().
test('AC-16 enabler: fresh-context-impl.run() writes snapshot in-process', async () => {
  const root = await setupRoot();
  try {
    const sid = 'deadbeef-1234-5678-9abc-def012345678';
    await writeSidecar(root, sid);

    const impl = require(path.join(__dirname, '..', '..', 'scripts', 'fresh-context-impl'));
    const result = impl.run({
      sessionId: sid,
      note: 'pre-compact (auto) — auto-saved before context compaction',
      workspaceRoot: root,
    });

    assert.ok(result.dest, 'run() must return dest path');
    assert.ok(fsSync.existsSync(result.dest), `snapshot file missing: ${result.dest}`);
    assert.match(path.basename(result.dest), /^deadbeef-\d{8}-\d{6}\.md$/);

    const latest = path.join(root, '.ai-session', 'resume', 'latest.md');
    assert.equal(fsSync.lstatSync(latest).isSymbolicLink(), false,
      'latest.md must remain a plain file');

    const content = await fs.readFile(latest, 'utf8');
    assert.match(content, /Resume Prompt/);
    assert.match(content, /pre-compact \(auto\)/);
    assert.match(content, /test-project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
