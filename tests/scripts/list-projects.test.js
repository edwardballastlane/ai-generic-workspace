'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'list-projects.js');
const isWin = process.platform === 'win32';

/**
 * Build a fake workspace at `root` with the canonical layout the script expects:
 *   <root>/scripts/list-projects.js  (copy of real script — must live alongside
 *                                     a sibling agent/_projects to compute paths)
 *   <root>/agent/_projects/
 *   <root>/.ai-config/settings.yaml  (optional, controlled by caller)
 *   <root>/.ai-contexts/
 *
 * The script resolves WORKSPACE_ROOT via `path.resolve(SCRIPT_DIR, '..')`, so we
 * place a copy of the .js inside <root>/scripts/ to anchor the workspace.
 */
async function makeWorkspace({ withSettings = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'list-proj-'));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'agent', '_projects'), { recursive: true });
  await fs.mkdir(path.join(root, '.ai-contexts'), { recursive: true });
  await fs.copyFile(SCRIPT, path.join(root, 'scripts', 'list-projects.js'));
  if (withSettings) {
    await fs.mkdir(path.join(root, '.ai-config'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.ai-config', 'settings.yaml'),
      'version: "1.0"\nplatform: bitbucket\n',
    );
  }
  return root;
}

function runScript(root, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'list-projects.js')], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
}

async function makeProject(root, name, files = {}) {
  const dir = path.join(root, 'agent', '_projects', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return dir;
}

// ── 1. No settings.yaml → exit 1 + Setup Required ───────────────────────────
test('exits 1 with Setup Required when .ai-config/settings.yaml absent', async () => {
  const root = await makeWorkspace({ withSettings: false });
  try {
    const r = runScript(root);
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /Setup Required/);
    assert.match(r.stdout, /\.\/scripts\/setup/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 2. Empty projects directory → "No projects found." + exit 0 ─────────────
test('prints "No projects found." and exits 0 when projects dir is empty', async () => {
  const root = await makeWorkspace();
  try {
    const r = runScript(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /No projects found\./);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 3. Project with .ai-contexts/<name>.yaml — language detected ────────────
test('detects language from .ai-contexts/<name>.yaml', async () => {
  const root = await makeWorkspace();
  try {
    await makeProject(root, 'svc-api');
    await fs.writeFile(
      path.join(root, '.ai-contexts', 'svc-api.yaml'),
      'tech:\n  language: "python"\n  frameworks: []\n',
    );
    const r = runScript(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /svc-api/);
    assert.match(r.stdout, /python/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 4. Project with .git → git remote URL appears in output ────────────────
test('shows git remote URL when project has a remote', async () => {
  const root = await makeWorkspace();
  try {
    const projDir = await makeProject(root, 'gitproj');
    execFileSync('git', ['init', '-q', projDir]);
    execFileSync('git', ['-C', projDir, 'remote', 'add', 'origin', 'https://example.com/me/gitproj.git']);
    const r = runScript(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /https:\/\/example\.com\/me\/gitproj\.git/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 5. POSIX symlink → marked as linked ─────────────────────────────────────
test('detects POSIX symlinked project as linked', { skip: isWin && 'symlink test runs on POSIX' }, async () => {
  const root = await makeWorkspace();
  try {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'real-proj-'));
    fsSync.symlinkSync(real, path.join(root, 'agent', '_projects', 'linked-proj'), 'dir');
    const r = runScript(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /linked-proj/);
    assert.match(r.stdout, /\(linked\)/);
    await fs.rm(real, { recursive: true, force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 6. Windows junction → marked as linked ──────────────────────────────────
test('detects Windows junction as linked', { skip: !isWin && 'junction test runs on Windows' }, async () => {
  const root = await makeWorkspace();
  try {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'real-proj-'));
    fsSync.symlinkSync(real, path.join(root, 'agent', '_projects', 'linked-junc'), 'junction');
    const r = runScript(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /linked-junc/);
    assert.match(r.stdout, /\(linked\)/);
    await fs.rm(real, { recursive: true, force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 7. Multiple projects → Promise.all parallelism — completes < 3s ─────────
test('completes within 3 s for 5+ git-bearing projects (parallel git remote)', async () => {
  const root = await makeWorkspace();
  try {
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    for (const n of names) {
      const dir = await makeProject(root, n);
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://example.com/${n}.git`]);
    }
    const start = Date.now();
    const r = runScript(root);
    const elapsed = Date.now() - start;
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(elapsed < 3000, `expected <3000ms, got ${elapsed}ms`);
    for (const n of names) assert.match(r.stdout, new RegExp(`https://example\\.com/${n}\\.git`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 8. NO_COLOR=1 → no escape sequences in stdout ──────────────────────────
test('NO_COLOR=1 strips all ANSI escape sequences', async () => {
  const root = await makeWorkspace();
  try {
    await makeProject(root, 'plain', { 'README.md': '# Plain Project\n' });
    const r = runScript(root, { NO_COLOR: '1' });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    // ESC (\x1b) must not appear anywhere on stdout.
    assert.ok(!r.stdout.includes('\x1b'), 'stdout contains ANSI escape under NO_COLOR=1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 9. chmod bit set on the script after first invocation (AC-19) ──────────
test('AC-19: executable bit is set on the script after invocation', async () => {
  const root = await makeWorkspace();
  try {
    const scriptCopy = path.join(root, 'scripts', 'list-projects.js');
    // Strip executable bits to force the script to set them.
    fsSync.chmodSync(scriptCopy, 0o644);
    runScript(root);
    const mode = fsSync.statSync(scriptCopy).mode;
    if (isWin) {
      // Mode bits are advisory on Windows; just assert the call did not crash
      // and the script still has read permission.
      assert.ok(mode & 0o400, 'owner read bit should be set');
    } else {
      assert.ok((mode & 0o100) !== 0, `owner-execute bit not set; mode=${(mode & 0o777).toString(8)}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
