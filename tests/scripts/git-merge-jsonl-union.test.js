'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'git-merge-jsonl-union.js');

function run(base, ours, theirs) {
  return spawnSync(process.execPath, [SCRIPT, base, ours, theirs], { encoding: 'utf8' });
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'jsonl-merge-'));
}

function writeJsonl(filePath, rows) {
  const body = rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  fs.writeFileSync(filePath, body);
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const E1 = { type: 'session_end', session_id: 's1', ts: '2026-01-01T00:00:00Z', task: 'one' };
const E2 = { type: 'session_end', session_id: 's2', ts: '2026-01-02T00:00:00Z', task: 'two' };
const E3 = { type: 'session_end', session_id: 's3', ts: '2026-01-03T00:00:00Z', task: 'three' };
const E4 = { type: 'session_end', session_id: 's4', ts: '2026-01-04T00:00:00Z', task: 'four' };

// value-events.jsonl schema: `sessionId` (always empty in practice) + `timestamp`.
const V1 = { timestamp: '2026-04-01T00:00:00.001Z', sessionId: '', type: 'rule_injection', count: 1 };
const V2 = { timestamp: '2026-04-01T00:00:00.002Z', sessionId: '', type: 'rule_injection', count: 2 };
const V3 = { timestamp: '2026-04-01T00:00:00.003Z', sessionId: '', type: 'rule_injection', count: 3 };

// ── Tests ────────────────────────────────────────────────────────────────────

test('union of disjoint inputs produces all events sorted by ts', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(ours, [E1, E2]);
    writeJsonl(theirs, [E3, E4]);

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const rows = readLines(ours).map(l => JSON.parse(l));
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(r => r.session_id), ['s1', 's2', 's3', 's4']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('dedupes by (session_id, ts) when both sides share an event', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(ours, [E1, E2]);
    writeJsonl(theirs, [E2, E3]);

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const rows = readLines(ours).map(l => JSON.parse(l));
    assert.equal(rows.length, 3, 'shared event should appear once');
    assert.deepEqual(rows.map(r => r.session_id), ['s1', 's2', 's3']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('dedupes identical raw (unparseable) lines', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(ours, ['garbage data', E1]);
    writeJsonl(theirs, ['garbage data', E2]);

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const lines = readLines(ours);
    const garbageCount = lines.filter(l => l === 'garbage data').length;
    assert.equal(garbageCount, 1, 'duplicate raw line should appear once');
    assert.equal(lines.length, 3);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('preserves unparseable line verbatim in output', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    const garbage = 'this {is not} valid json @@@';
    writeJsonl(ours, [garbage, E1]);
    writeJsonl(theirs, [E2]);

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const lines = readLines(ours);
    assert.ok(lines.includes(garbage), `expected verbatim raw line in output, got:\n${lines.join('\n')}`);
    // Raw entries sort to the front (empty ts).
    assert.equal(lines[0], garbage);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('missing OURS file: merge succeeds with THEIRS contents written to OURS path', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'does-not-exist.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(theirs, [E1, E2]);

    assert.equal(fs.existsSync(ours), false, 'precondition: ours missing');

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const rows = readLines(ours).map(l => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.session_id), ['s1', 's2']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('value-events schema: distinct events with empty sessionId are all preserved, sorted by timestamp', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(ours, [V1, V3]);
    writeJsonl(theirs, [V2]);

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const rows = readLines(ours).map(l => JSON.parse(l));
    assert.equal(rows.length, 3, 'distinct value-events must not collapse despite empty sessionId');
    assert.deepEqual(rows.map(r => r.timestamp), [V1.timestamp, V2.timestamp, V3.timestamp]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('value-events schema: byte-identical lines on both sides dedupe to one', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(ours, [V1, V2]);
    writeJsonl(theirs, [V2, V3]);  // V2 shared verbatim

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const rows = readLines(ours).map(l => JSON.parse(l));
    assert.equal(rows.length, 3, 'shared value-event should appear once');
    assert.deepEqual(rows.map(r => r.timestamp), [V1.timestamp, V2.timestamp, V3.timestamp]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('emits stderr summary line with ours/theirs/unique counts', async () => {
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'base.jsonl');
    const ours = path.join(dir, 'ours.jsonl');
    const theirs = path.join(dir, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    writeJsonl(ours, [E1, E2]);          // 2 ours
    writeJsonl(theirs, [E2, E3, E4]);    // 3 theirs, E2 shared

    const r = run(base, ours, theirs);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /jsonl-union: merged 2 ours \+ 3 theirs → 4 unique events/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
