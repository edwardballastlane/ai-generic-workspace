'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

// scripts/set-ai-estimate.js resolves its root as
// `process.env.AI_ESTIMATE_ROOT || path.dirname(__dirname)` — matching its
// write-capable siblings (session-stop.js's `LANE_EVENTS_ROOT`,
// token-dashboard.js's `TOKEN_DASHBOARD_ROOT`). Each test runs the real repo
// script against a fresh tempdir passed via `AI_ESTIMATE_ROOT`, so all
// `.ai-memory/ai-estimates.json` / `.ai-session/**` reads and writes land in
// the sandbox and never touch this repo's tracked state.
async function makeSandbox() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sae-'));
}

const REAL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'set-ai-estimate.js');

function cachePath(root) {
  return path.join(root, '.ai-memory', 'ai-estimates.json');
}

function sidecarPath(root, sid) {
  return path.join(root, '.ai-session', 'by-id', `${sid}.json`);
}

function run(root, args, envOverrides = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_MODEL;
  env.AI_ESTIMATE_ROOT = root;
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [REAL_SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

async function cleanup(root) {
  await fsp.rm(root, { recursive: true, force: true });
}

test('AC-1: valid call creates cache with correct entry shape', async () => {
  const root = await makeSandbox();
  try {
    const r = run(root, ['--ticket', 'PROJ-1234', '--ai-sp', '3', '--basis', 'create']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.ok(fs.existsSync(cachePath(root)), 'cache file should be created');
    const cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    const entry = cache.entries['PROJ-1234'];
    assert.ok(entry, 'entry for PROJ-1234 should exist');
    assert.equal(entry.ai_sp, 3);
    assert.equal(entry.basis, 'create');
    assert.equal(entry.estimator, 'unknown');
    assert.ok(!Number.isNaN(Date.parse(entry.estimated_at)), 'estimated_at should be a valid ISO timestamp');
  } finally {
    await cleanup(root);
  }
});

test('AC-2: a second call with a different basis fully replaces the entry (not appended)', async () => {
  const root = await makeSandbox();
  try {
    const r1 = run(root, ['--ticket', 'PROJ-2000', '--ai-sp', '3', '--basis', 'create']);
    assert.equal(r1.status, 0, `exit ${r1.status}\nstderr=${r1.stderr}`);

    const r2 = run(root, ['--ticket', 'PROJ-2000', '--ai-sp', '5', '--basis', 'post-plan']);
    assert.equal(r2.status, 0, `exit ${r2.status}\nstderr=${r2.stderr}`);

    const cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    assert.equal(Object.keys(cache.entries).length, 1, 'should still be exactly one entry, not appended');
    const entry = cache.entries['PROJ-2000'];
    assert.equal(entry.ai_sp, 5);
    assert.equal(entry.basis, 'post-plan');
  } finally {
    await cleanup(root);
  }
});

test('AC-3: a corrupt existing cache file is tolerated; a valid call still succeeds', async () => {
  const root = await makeSandbox();
  try {
    fs.mkdirSync(path.dirname(cachePath(root)), { recursive: true });
    fs.writeFileSync(cachePath(root), '{ this is not valid json,,,');

    const r = run(root, ['--ticket', 'PROJ-3000', '--ai-sp', '1', '--basis', 'create']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    // Must not throw -- loader tolerated the corruption and produced valid JSON.
    const cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    assert.equal(cache.entries['PROJ-3000'].ai_sp, 1);
  } finally {
    await cleanup(root);
  }
});

test('AC-4: invalid ticket key rejects with non-zero exit, stderr, and no cache write', async () => {
  const root = await makeSandbox();
  try {
    const r = run(root, ['--ticket', 'notaticket', '--ai-sp', '3', '--basis', 'create']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.length > 0, 'expected a stderr validation message');
    assert.equal(fs.existsSync(cachePath(root)), false, 'cache file must not be written on validation failure');
  } finally {
    await cleanup(root);
  }
});

test('AC-5: off-scale --ai-sp rejects with non-zero exit and no cache write', async () => {
  const root = await makeSandbox();
  try {
    const r = run(root, ['--ticket', 'PROJ-1', '--ai-sp', '4', '--basis', 'create']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.length > 0, 'expected a stderr validation message');
    assert.equal(fs.existsSync(cachePath(root)), false);
  } finally {
    await cleanup(root);
  }
});

test('AC-6: invalid or missing --basis rejects with non-zero exit and no cache write', async () => {
  const root = await makeSandbox();
  try {
    const rBad = run(root, ['--ticket', 'PROJ-1', '--ai-sp', '3', '--basis', 'foo']);
    assert.notEqual(rBad.status, 0);
    assert.ok(rBad.stderr.length > 0, 'expected a stderr validation message');
    assert.equal(fs.existsSync(cachePath(root)), false);

    const rMissing = run(root, ['--ticket', 'PROJ-1', '--ai-sp', '3']);
    assert.notEqual(rMissing.status, 0);
    assert.ok(rMissing.stderr.length > 0, 'expected a stderr validation message');
    assert.equal(fs.existsSync(cachePath(root)), false);
  } finally {
    await cleanup(root);
  }
});

test('AC-7: CLAUDE_SESSION_ID env stamps ai_estimated on the sidecar and preserves other fields', async () => {
  const root = await makeSandbox();
  try {
    const sid = 'sess-ac7-0001';
    fs.mkdirSync(path.join(root, '.ai-session', 'by-id'), { recursive: true });
    const before = { task: 'PROJ-9', model: 'claude-opus-4-8', other_field: 'keep-me' };
    fs.writeFileSync(sidecarPath(root, sid), JSON.stringify(before, null, 2));

    const r = run(root, ['--ticket', 'PROJ-7000', '--ai-sp', '2', '--basis', 'create'], {
      CLAUDE_SESSION_ID: sid,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const after = JSON.parse(fs.readFileSync(sidecarPath(root, sid), 'utf8'));
    assert.equal(after.ai_estimated, 2);
    assert.equal(after.task, 'PROJ-9', 'unrelated field should be preserved');
    assert.equal(after.model, 'claude-opus-4-8', 'unrelated field should be preserved');
    assert.equal(after.other_field, 'keep-me', 'unrelated field should be preserved');
  } finally {
    await cleanup(root);
  }
});

test('AC-8: current.yaml claude_session_id fallback resolves sid and stamps the sidecar', async () => {
  const root = await makeSandbox();
  try {
    const sid = 'sess-ac8-0002';
    fs.mkdirSync(path.join(root, '.ai-session', 'by-id'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-session', 'current.yaml'), `claude_session_id: "${sid}"\n`);
    fs.writeFileSync(sidecarPath(root, sid), JSON.stringify({ task: 'PROJ-8' }, null, 2));

    // No CLAUDE_SESSION_ID env var (run() strips it by default).
    const r = run(root, ['--ticket', 'PROJ-8000', '--ai-sp', '1', '--basis', 'post-plan']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const after = JSON.parse(fs.readFileSync(sidecarPath(root, sid), 'utf8'));
    assert.equal(after.ai_estimated, 1);
    assert.equal(after.task, 'PROJ-8', 'unrelated field should be preserved');
  } finally {
    await cleanup(root);
  }
});

test('AC-9: no resolvable session id -> exits 0, cache still written, no sidecar error surfaced', async () => {
  const root = await makeSandbox();
  try {
    const r = run(root, ['--ticket', 'PROJ-9000', '--ai-sp', '0.5', '--basis', 'create']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.equal(r.stderr, '', 'no sidecar-related error should be printed');

    const cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    assert.equal(cache.entries['PROJ-9000'].ai_sp, 0.5);
  } finally {
    await cleanup(root);
  }
});

test('AC-10: estimator precedence -- --estimator flag > CLAUDE_MODEL env > "unknown"', async () => {
  const root = await makeSandbox();
  try {
    const rFlag = run(
      root,
      ['--ticket', 'PROJ-10001', '--ai-sp', '1', '--basis', 'create', '--estimator', 'foo'],
      { CLAUDE_MODEL: 'claude-opus-4-8' }
    );
    assert.equal(rFlag.status, 0, `exit ${rFlag.status}\nstderr=${rFlag.stderr}`);
    let cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    assert.equal(cache.entries['PROJ-10001'].estimator, 'foo', '--estimator flag should win');

    const rEnv = run(root, ['--ticket', 'PROJ-10002', '--ai-sp', '1', '--basis', 'create'], {
      CLAUDE_MODEL: 'claude-opus-4-8',
    });
    assert.equal(rEnv.status, 0, `exit ${rEnv.status}\nstderr=${rEnv.stderr}`);
    cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    assert.equal(cache.entries['PROJ-10002'].estimator, 'claude-opus-4-8', 'CLAUDE_MODEL should be used as fallback');

    const rNone = run(root, ['--ticket', 'PROJ-10003', '--ai-sp', '1', '--basis', 'create']);
    assert.equal(rNone.status, 0, `exit ${rNone.status}\nstderr=${rNone.stderr}`);
    cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    assert.equal(cache.entries['PROJ-10003'].estimator, 'unknown', 'defaults to "unknown" with neither flag nor env');
  } finally {
    await cleanup(root);
  }
});
