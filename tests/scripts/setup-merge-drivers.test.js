'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'setup-merge-drivers.js');

const EXPECTED_NAME = 'JSONL union merge (session events)';
const EXPECTED_DRIVER = 'node ./scripts/git-merge-jsonl-union.js %O %A %B';

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function gitConfigGet(dir, key) {
  return execFileSync('git', ['config', '--get', key], { cwd: dir, encoding: 'utf8' }).trim();
}

function runScript(cwd) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
}

test('AC-1: registers merge.jsonl-union.name and .driver in a git repo', async () => {
  const dir = await tmpDir('setup-merge-ok-');
  try {
    initRepo(dir);
    const r = runScript(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.equal(gitConfigGet(dir, 'merge.jsonl-union.name'), EXPECTED_NAME);
    assert.equal(gitConfigGet(dir, 'merge.jsonl-union.driver'), EXPECTED_DRIVER);
    assert.match(r.stdout, /Registered merge driver: jsonl-union/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-2: exits non-zero with error message when not in a git repo', async () => {
  const dir = await tmpDir('setup-merge-nogit-');
  try {
    const r = runScript(dir);
    assert.notEqual(r.status, 0, 'expected non-zero exit outside a git repo');
    assert.match(r.stderr, /not a git repository/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-3: idempotent — running twice succeeds and config values unchanged', async () => {
  const dir = await tmpDir('setup-merge-idem-');
  try {
    initRepo(dir);

    const r1 = runScript(dir);
    assert.equal(r1.status, 0, `first run exit ${r1.status}\nstderr=${r1.stderr}`);
    const name1 = gitConfigGet(dir, 'merge.jsonl-union.name');
    const driver1 = gitConfigGet(dir, 'merge.jsonl-union.driver');

    const r2 = runScript(dir);
    assert.equal(r2.status, 0, `second run exit ${r2.status}\nstderr=${r2.stderr}`);
    const name2 = gitConfigGet(dir, 'merge.jsonl-union.name');
    const driver2 = gitConfigGet(dir, 'merge.jsonl-union.driver');

    assert.equal(name1, EXPECTED_NAME);
    assert.equal(driver1, EXPECTED_DRIVER);
    assert.equal(name2, name1);
    assert.equal(driver2, driver1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('runs from a subdirectory of the repo (rev-parse --show-toplevel)', async () => {
  const dir = await tmpDir('setup-merge-sub-');
  try {
    initRepo(dir);
    const sub = path.join(dir, 'nested', 'deep');
    fs.mkdirSync(sub, { recursive: true });

    const r = runScript(sub);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.equal(gitConfigGet(dir, 'merge.jsonl-union.driver'), EXPECTED_DRIVER);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
