'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-gate.js');

// The CLI is the only place `.lane-verify.json` is read from disk, the only place
// commands actually execute, and the only place a verdict is recorded — none of
// which the pure-lib tests cover.
const TEMP_DIRS = [];
test.after(async () => {
  for (const dir of TEMP_DIRS) await fsp.rm(dir, { recursive: true, force: true });
});

async function repoWith(config, extraFiles = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'verify-gate-cli-'));
  TEMP_DIRS.push(dir);
  if (config) await fsp.writeFile(path.join(dir, '.lane-verify.json'), JSON.stringify(config, null, 2));
  for (const [rel, text] of Object.entries(extraFiles)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text);
  }
  return dir;
}

function run(repoRoot, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, repoRoot, ...args], {
    encoding: 'utf8',
    // Keep the verdict recorder pointed at the temp repo, never the real workspace.
    env: { ...process.env, LANE_EVENTS_ROOT: repoRoot, WORKSPACE_ROOT: repoRoot },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('no .lane-verify.json — skips, says so, exits 0', async () => {
  const dir = await repoWith(null);
  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /no \.lane-verify\.json — skipped \(opt-in\)/);
});

test('all commands pass — reports PASS and exits 0', async () => {
  const dir = await repoWith({ commands: [{ name: 'ok', run: `"${process.execPath}" -e "process.exit(0)"` }] });
  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /verify-gate: PASS/);
  assert.match(out, /1 command\(s\) passed/);
});

test('a failing command yields FAIL but STILL exits 0 (advisory, never blocks)', async () => {
  const dir = await repoWith({
    commands: [
      { name: 'tests', run: `"${process.execPath}" -e "process.exit(1)"` },
      { name: 'lint', run: `"${process.execPath}" -e "process.exit(0)"` },
    ],
  });
  const { code, out } = run(dir);
  assert.equal(code, 0, 'advisory gate must never fail the caller');
  assert.match(out, /verify-gate: FAIL — failed: tests/);
  assert.doesNotMatch(out, /failed:.*lint/);
  assert.match(out, /advisory — not blocking/);
});

test('whenPathsChanged: --files outside the list skips the run', async () => {
  const dir = await repoWith({
    commands: [{ name: 'boom', run: `"${process.execPath}" -e "process.exit(1)"` }],
    whenPathsChanged: ['scripts/'],
  });
  const { code, out } = run(dir, ['--files', 'README.md']);
  assert.equal(code, 0);
  assert.match(out, /no matching changed paths — skipped/);
  assert.doesNotMatch(out, /FAIL/);
});

test('whenPathsChanged: a matching --files entry runs the commands', async () => {
  const dir = await repoWith({
    commands: [{ name: 'boom', run: `"${process.execPath}" -e "process.exit(1)"` }],
    whenPathsChanged: ['scripts/'],
  });
  const { out } = run(dir, ['--files', 'scripts/foo.js,README.md']);
  assert.match(out, /verify-gate: FAIL — failed: boom/);
});

test('no --files at all runs the gate (ANY_FILE), so a path filter cannot silently disable it', async () => {
  const dir = await repoWith({
    commands: [{ name: 'boom', run: `"${process.execPath}" -e "process.exit(1)"` }],
    whenPathsChanged: ['scripts/'],
  });
  const { out } = run(dir);
  assert.match(out, /verify-gate: FAIL/);
});

test('--quiet prints nothing on either verdict', async () => {
  const pass = await repoWith({ commands: [{ name: 'ok', run: `"${process.execPath}" -e "process.exit(0)"` }] });
  const fail = await repoWith({ commands: [{ name: 'no', run: `"${process.execPath}" -e "process.exit(1)"` }] });
  assert.equal(run(pass, ['--quiet']).out.trim(), '');
  assert.equal(run(fail, ['--quiet']).out.trim(), '');
});

test('the run records a verifier_verdict carrying the real outcome', async () => {
  const dir = await repoWith({ commands: [{ name: 'tests', run: `"${process.execPath}" -e "process.exit(1)"` }] });
  run(dir, ['--session', 'cli-test-session']);

  const logPath = path.join(dir, '.claude', 'logs', 'value-events.jsonl');
  assert.ok(fs.existsSync(logPath), `expected a value-event log at ${logPath}`);

  const rows = fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'verifier_verdict');

  assert.ok(rows.length > 0, 'no verifier_verdict row recorded');
  const row = rows[rows.length - 1];
  assert.equal(row.sessionId, 'cli-test-session');
  assert.equal(row.count, 0, 'a FAIL must be recorded as 0, not 1');
  assert.equal(row.details.verdict, 'FAIL', 'a failing gate must never record a PASS');
  assert.deepEqual(row.details.failed, ['tests']);
  assert.equal(row.details.source, 'verify-gate');
});

test('a malformed .lane-verify.json does not crash the CLI', async () => {
  const dir = await repoWith(null);
  await fsp.writeFile(path.join(dir, '.lane-verify.json'), '{ not json');
  const { code } = run(dir);
  assert.equal(code, 0);
});
