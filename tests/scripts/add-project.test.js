'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'add-project.js');
const isWin = process.platform === 'win32';

const {
  isGithubUrl, isBitbucketUrl, isGitlabUrl, isAzureUrl, isGitUrl,
  isLocalPath, expandHome, getProjectName, detectGitPlatform,
  stripGitBlock,
} = require('../../scripts/add-project.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'addproj-'));
  await fsp.mkdir(path.join(root, 'agent', '_projects'), { recursive: true });
  await fsp.mkdir(path.join(root, '.ai-contexts'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'lane.code-workspace'),
    JSON.stringify({ folders: [{ name: 'Lane (workspace)', path: '.' }] }, null, 2) + '\n'
  );
  return root;
}

function run(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANE_ROOT: root, NO_COLOR: '1', ...extraEnv },
  });
}

// ── Unit tests on detection helpers ──────────────────────────────────────────

test('source detection helpers classify URLs correctly', () => {
  assert.equal(isGithubUrl('https://github.com/u/r'), true);
  assert.equal(isGithubUrl('git@github.com:u/r.git'), true);
  assert.equal(isGithubUrl('github.com/u/r'), true);
  assert.equal(isBitbucketUrl('https://bitbucket.org/ws/r'), true);
  assert.equal(isBitbucketUrl('git@bitbucket.org:ws/r.git'), true);
  assert.equal(isGitlabUrl('https://gitlab.com/u/r'), true);
  assert.equal(isGitlabUrl('https://gitlab.example.com/u/r'), true);
  assert.equal(isAzureUrl('https://dev.azure.com/org/proj/_git/repo'), true);
  assert.equal(isAzureUrl('https://org.visualstudio.com/proj'), true);
  assert.equal(isGitUrl('https://github.com/u/r'), true);
  assert.equal(isGitUrl('plain-name'), false);
});

test('detectGitPlatform identifies platform from remote URL (AC-11 unit)', () => {
  assert.equal(detectGitPlatform('https://github.com/u/r').platform, 'github');
  assert.equal(detectGitPlatform('git@github.com:u/r.git').platform, 'github');
  assert.equal(detectGitPlatform('https://bitbucket.org/ws/r').platform, 'bitbucket');
  assert.equal(detectGitPlatform('https://bitbucket.org/myws/repo').workspace, 'myws');
  assert.equal(detectGitPlatform('https://gitlab.com/u/r').platform, 'gitlab');
  assert.equal(detectGitPlatform('https://dev.azure.com/o/p').platform, 'azure');
  assert.equal(detectGitPlatform('').platform, 'other');
  assert.equal(detectGitPlatform('https://example.com/u/r').platform, 'other');
});

test('expandHome substitutes ~ for os.homedir()', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/foo'), path.join(os.homedir(), 'foo'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('rel'), 'rel');
});

test('getProjectName extracts repo / folder / new-name', () => {
  assert.equal(getProjectName('https://github.com/u/my-repo.git'), 'my-repo');
  assert.equal(getProjectName('git@github.com:u/awesome.git'), 'awesome');
  assert.equal(getProjectName('my-new-app'), 'my-new-app');
});

test('stripGitBlock removes git: section even at EOF (bash sed bug fix)', () => {
  const eof = `version: "2.0"\nproject: "x"\n\ngit:\n  platform: "github"\n  cli: "gh"\n`;
  const stripped = stripGitBlock(eof);
  assert.equal(/^git:/m.test(stripped), false);
  assert.match(stripped, /version: "2.0"/);

  const middle = `version: "2.0"\n\ngit:\n  platform: "github"\n\nproduct:\n  name: "x"\n`;
  const s2 = stripGitBlock(middle);
  assert.equal(/^git:/m.test(s2), false);
  assert.match(s2, /product:/);
});

// ── AC-8: new-project name scaffolds dir + git init ──────────────────────────

test('AC-8: new-project name scaffolds empty dir with .git initialized', async () => {
  const root = await setupRoot();
  try {
    const r = run(root, ['my-new-app']);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const dest = path.join(root, 'agent', '_projects', 'my-new-app');
    assert.ok(fs.statSync(dest).isDirectory(), 'project dir created');
    assert.ok(fs.statSync(path.join(dest, 'docs')).isDirectory(), 'docs/ created');
    assert.ok(fs.statSync(path.join(dest, 'src')).isDirectory(), 'src/ created');
    assert.ok(fs.existsSync(path.join(dest, 'README.md')), 'README.md created');
    // git init must have run
    assert.ok(fs.existsSync(path.join(dest, '.git')), '.git initialized');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-9: local path symlink (POSIX) — lstat.isSymbolicLink() === true ──────

test('AC-9 / AC-21: local path creates a symlink (POSIX) verifiable via lstat',
  { skip: isWin && 'POSIX-only test' },
  async () => {
    const root = await setupRoot();
    const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'addproj-target-'));
    try {
      await fsp.writeFile(path.join(targetDir, 'marker.txt'), 'hi');
      const r = run(root, [targetDir, 'myname']);
      assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      const dest = path.join(root, 'agent', '_projects', 'myname');
      const stat = fs.lstatSync(dest);
      assert.equal(stat.isSymbolicLink(), true, 'must be a symlink (AC-21)');
      // symlink target file is reachable
      assert.equal(fs.readFileSync(path.join(dest, 'marker.txt'), 'utf8'), 'hi');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

// ── AC-9 / AC-21: junction on Windows ────────────────────────────────────────

test('AC-9 / AC-21: local path creates a junction (Windows) verifiable via lstat',
  { skip: !isWin && 'Windows-only test' },
  async () => {
    const root = await setupRoot();
    const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'addproj-target-'));
    try {
      await fsp.writeFile(path.join(targetDir, 'marker.txt'), 'hi');
      const r = run(root, [targetDir, 'myname']);
      assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      const dest = path.join(root, 'agent', '_projects', 'myname');
      // Node 20+: junctions report isSymbolicLink() === true
      assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, 'junction lstat (AC-21)');
      assert.match(r.stdout, /linked \(junction\)/);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

// ── --copy flag ──────────────────────────────────────────────────────────────

test('--copy flag copies files instead of linking', async () => {
  const root = await setupRoot();
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'addproj-target-'));
  try {
    await fsp.writeFile(path.join(targetDir, 'marker.txt'), 'copied');
    const r = run(root, ['--copy', targetDir, 'copyname']);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const dest = path.join(root, 'agent', '_projects', 'copyname');
    const stat = fs.lstatSync(dest);
    assert.equal(stat.isSymbolicLink(), false, 'must NOT be a symlink under --copy');
    assert.equal(stat.isDirectory(), true, 'must be a real directory');
    assert.equal(fs.readFileSync(path.join(dest, 'marker.txt'), 'utf8'), 'copied');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(targetDir, { recursive: true, force: true });
  }
});

// ── AC-10: lane.code-workspace updated via JSON.parse + atomicWrite ─────────

test('AC-10: lane.code-workspace gains an entry parseable as JSON', async () => {
  const root = await setupRoot();
  try {
    const r = run(root, ['demo-app']);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const ws = JSON.parse(fs.readFileSync(path.join(root, 'lane.code-workspace'), 'utf8'));
    const entry = ws.folders.find(f => f.name === 'demo-app');
    assert.ok(entry, 'workspace entry created');
    assert.match(entry.path, /agent[\\/]_projects[\\/]demo-app/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-10 (cont.): .ai-contexts/<name>.yaml written ─────────────────────────

test('AC-10: .ai-contexts/<name>.yaml is written with project + git metadata', async () => {
  const root = await setupRoot();
  try {
    const r = run(root, ['ctx-app']);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const yaml = fs.readFileSync(path.join(root, '.ai-contexts', 'ctx-app.yaml'), 'utf8');
    assert.match(yaml, /project: "ctx-app"/);
    assert.match(yaml, /^git:/m);
    assert.match(yaml, /platform:/);
    assert.match(yaml, /default_branch:/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-11: git URL platform detection writes platform: github to yaml ───────

test('AC-11: cloning a github URL writes platform: "github" to context yaml', async () => {
  // Use a local bare-ish source repo to avoid network calls. We simulate a
  // github remote by initializing a repo and pointing origin at a github URL,
  // then cloning that repo. The cloned repo's `git remote get-url origin`
  // returns the github URL we set on the upstream.
  const root = await setupRoot();
  const upstream = await fsp.mkdtemp(path.join(os.tmpdir(), 'addproj-upstream-'));
  try {
    execFileSync('git', ['init', '--bare', upstream], { stdio: 'ignore' });
    // Add a fake github remote to the upstream's config so clones inherit it via... wait —
    // a bare upstream's URL is what `git clone` records. We cannot change that to github.com
    // without network. Instead, do the simpler thing: construct the yaml flow directly via
    // a manual call: clone our local bare repo then mutate origin to a github URL.
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'addproj-work-'));
    execFileSync('git', ['clone', upstream, work], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'remote', 'set-url', 'origin', 'https://github.com/test/repo.git'], { stdio: 'ignore' });
    // Now run add-project with a local path pointing at `work` — saveGitConfig will
    // read origin and detect github.
    const r = run(root, [work, 'gh-app']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const yaml = fs.readFileSync(path.join(root, '.ai-contexts', 'gh-app.yaml'), 'utf8');
    assert.match(yaml, /platform: "github"/);
    assert.match(yaml, /cli: "gh"/);
    await fsp.rm(work, { recursive: true, force: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(upstream, { recursive: true, force: true });
  }
});

// ── invalid args ────────────────────────────────────────────────────────────

test('no <source> arg exits 1 with usage hint', async () => {
  const root = await setupRoot();
  try {
    const r = run(root, []);
    assert.notEqual(r.status, 0, 'must exit non-zero without <source>');
    assert.match(r.stderr + r.stdout, /Usage:/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('unknown flag exits 1', async () => {
  const root = await setupRoot();
  try {
    const r = run(root, ['--bogus', 'name']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /Unknown flag/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-19: executable bit set on the script ─────────────────────────────────

test('AC-19: script file has executable bit set after invocation', async () => {
  const root = await setupRoot();
  try {
    const r = run(root, ['probe-app']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    if (!isWin) {
      const mode = fs.statSync(SCRIPT).mode & 0o777;
      assert.ok((mode & 0o111) !== 0, `executable bit missing (mode=${mode.toString(8)})`);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── existing-project guard ──────────────────────────────────────────────────

test('existing project name reports already-exists and exits 0', async () => {
  const root = await setupRoot();
  try {
    const dest = path.join(root, 'agent', '_projects', 'dupe');
    fs.mkdirSync(dest, { recursive: true });
    const r = run(root, ['dupe']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already exists/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
