'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'audit-session-attribution.js');

function run(env = {}, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const SID_A = 'aaaaaaaa-1111-2222-3333-000000000001';
const SID_B = 'bbbbbbbb-1111-2222-3333-000000000002';

// ── AC-5: empty session_id counted in human-readable mode ────────────────────

test('AC-5: human-readable mode reports empty_session_id count', async () => {
  const dir = await tmpDir('audit-emptysid-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', task: 'no sid 1' },
      { ts: '2026-01-01T00:01:00Z', task: 'no sid 2', session_id: '' },
      { ts: '2026-01-01T00:02:00Z', task: 'has sid', session_id: SID_A,
        jira_ticket: 'PROJ-1', project: 'p1' },
    ]);
    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      SIDECAR_DIR_OVERRIDE: path.join(dir, 'no-such-sidecar-dir'),
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /empty session_id\s+2\b/);
    assert.match(r.stdout, /events scanned\s+3\b/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-6: same sid with two distinct jira_ticket → split_attribution ─────────

test('AC-6: --json split_attribution.count === 1 with both tickets in array', async () => {
  const dir = await tmpDir('audit-split-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_A,
        jira_ticket: 'PROJ-1', project: 'p1' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_A,
        jira_ticket: 'PROJ-2', project: 'p1' },
    ]);
    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      SIDECAR_DIR_OVERRIDE: path.join(dir, 'no-such-sidecar-dir'),
    }, ['--json']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.split_attribution.count, 1);
    const session = report.split_attribution.sessions[0];
    assert.equal(session.sid, SID_A);
    assert.deepEqual(session.tickets.sort(), ['PROJ-1', 'PROJ-2']);
    assert.equal(session.events, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-7: sidecar drift (project mismatch) ───────────────────────────────────

test('AC-7: --json sidecar_drift.count === 1 when project disagrees', async () => {
  const dir = await tmpDir('audit-drift-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const sidecarDir = path.join(dir, 'sidecar');
    fs.mkdirSync(sidecarDir, { recursive: true });
    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_A,
        jira_ticket: 'PROJ-1', project: 'X' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_A,
        jira_ticket: 'PROJ-1', project: 'X' },
    ]);
    fs.writeFileSync(path.join(sidecarDir, `${SID_A}.json`),
      JSON.stringify({ project: 'Y', jira_ticket: 'PROJ-1' }));
    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      SIDECAR_DIR_OVERRIDE: sidecarDir,
    }, ['--json']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.sidecar_drift.count, 1);
    const d = report.sidecar_drift.sessions[0];
    assert.equal(d.sid, SID_A);
    assert.equal(d.ev_project, 'X');
    assert.equal(d.sc_project, 'Y');
    assert.equal(d.ev_jira, 'PROJ-1');
    assert.equal(d.sc_jira, 'PROJ-1');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-8: missing events file → stderr message, exit 0 ──────────────────────

test('AC-8: missing events file emits "no events file" to stderr and exits 0', async () => {
  const dir = await tmpDir('audit-missing-');
  try {
    const eventsFile = path.join(dir, 'does-not-exist.jsonl');
    const r = run({ EVENTS_FILE_OVERRIDE: eventsFile });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /no events file/);
    assert.match(r.stderr, /nothing to audit/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-9: clean run prints "no attribution drift detected" ──────────────────

test('AC-9: clean events file prints "no attribution drift detected"', async () => {
  const dir = await tmpDir('audit-clean-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_A,
        jira_ticket: 'PROJ-1', project: 'p1' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_B,
        jira_ticket: 'PROJ-2', project: 'p2' },
    ]);
    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      SIDECAR_DIR_OVERRIDE: path.join(dir, 'no-such-sidecar-dir'),
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /no attribution drift detected/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
