'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  monthKey,
  shardPath,
  currentShardPath,
  listEventFiles,
  readAllLines,
  readAllEvents,
} = require('../../scripts/_lib/session-events');

async function setupRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-'));
  await fsp.mkdir(path.join(root, '.ai-memory'), { recursive: true });
  return root;
}

function write(root, name, lines) {
  fs.writeFileSync(path.join(root, '.ai-memory', name), lines.join('\n') + '\n');
}

test('monthKey derives UTC YYYY-MM from a Date or ISO string', () => {
  assert.equal(monthKey('2026-06-18T21:00:00Z'), '2026-06');
  assert.equal(monthKey(new Date('2026-12-01T00:00:00Z')), '2026-12');
  // UTC, not local — a Jan 1 00:30 UTC stays in January
  assert.equal(monthKey('2026-01-01T00:30:00Z'), '2026-01');
});

test('shardPath accepts a month key or a timestamp', () => {
  const root = '/tmp/x';
  assert.equal(shardPath(root, '2026-06'), path.join(root, '.ai-memory', 'session-end-events-2026-06.jsonl'));
  assert.equal(shardPath(root, '2026-06-18T10:00:00Z'), path.join(root, '.ai-memory', 'session-end-events-2026-06.jsonl'));
});

test('currentShardPath points at the given month', () => {
  const p = currentShardPath('/tmp/x', new Date('2026-07-15T00:00:00Z'));
  assert.equal(path.basename(p), 'session-end-events-2026-07.jsonl');
});

test('listEventFiles returns legacy first, then shards ascending', async () => {
  const root = await setupRoot();
  try {
    write(root, 'session-end-events.jsonl', ['{"a":1}']);
    write(root, 'session-end-events-2026-07.jsonl', ['{"b":1}']);
    write(root, 'session-end-events-2026-06.jsonl', ['{"c":1}']);
    // a non-matching file must be ignored
    write(root, 'session-end-events-backup.txt', ['ignore me']);
    const files = listEventFiles(root).map(f => path.basename(f));
    assert.deepEqual(files, [
      'session-end-events.jsonl',
      'session-end-events-2026-06.jsonl',
      'session-end-events-2026-07.jsonl',
    ]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('listEventFiles omits legacy when absent and tolerates empty dir', async () => {
  const root = await setupRoot();
  try {
    assert.deepEqual(listEventFiles(root), []);
    write(root, 'session-end-events-2026-06.jsonl', ['{"c":1}']);
    assert.deepEqual(listEventFiles(root).map(f => path.basename(f)), ['session-end-events-2026-06.jsonl']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('readAllLines unions every file and skips blank lines', async () => {
  const root = await setupRoot();
  try {
    write(root, 'session-end-events.jsonl', ['{"x":1}', '', '{"x":2}']);
    write(root, 'session-end-events-2026-06.jsonl', ['{"x":3}']);
    const lines = readAllLines(root);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => JSON.parse(l).x), [1, 2, 3]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('readAllEvents parses, skips malformed, and filters by type', async () => {
  const root = await setupRoot();
  try {
    write(root, 'session-end-events.jsonl', [
      '{"type":"session_end","id":1}',
      'NOT JSON',
      '{"type":"other","id":2}',
    ]);
    write(root, 'session-end-events-2026-06.jsonl', ['{"type":"session_end","id":3}']);
    const all = readAllEvents(root);
    assert.deepEqual(all.map(e => e.id), [1, 2, 3]); // malformed dropped
    const ends = readAllEvents(root, 'session_end');
    assert.deepEqual(ends.map(e => e.id), [1, 3]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
