'use strict';

// self-metrics is TypeScript; register ts-node so this node:test file can import it.
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  aggregateSessions, aggregateReflections, qualityBucket,
  upsertSessionMetric, appendReflectionMetrics, readSessionMetrics, readReflectionMetrics,
} = require('../../scripts/session-embedder/self-metrics');

test('qualityBucket maps scores to the dashboard histogram buckets', () => {
  assert.equal(qualityBucket(1), '1-2');
  assert.equal(qualityBucket(2), '1-2');
  assert.equal(qualityBucket(4), '3-4');
  assert.equal(qualityBucket(6), '5-6');
  assert.equal(qualityBucket(8), '7-8');
  assert.equal(qualityBucket(10), '9-10');
});

test('aggregateSessions sums chunks + quality histograms and counts unique sessions per ISO week', () => {
  const rows = [
    { sessionId: 'a', date: '2026-06-01T00:00:00Z', chunks: 10, scored: 10, quality: { '1-2': 0, '3-4': 0, '5-6': 2, '7-8': 5, '9-10': 3 } },
    { sessionId: 'b', date: '2026-06-02T00:00:00Z', chunks: 5, scored: 0, quality: { '1-2': 0, '3-4': 0, '5-6': 0, '7-8': 0, '9-10': 0 } },
    { sessionId: 'c', date: '2026-06-15T00:00:00Z', chunks: 7, scored: 7, quality: { '1-2': 1, '3-4': 0, '5-6': 0, '7-8': 0, '9-10': 6 } },
  ];
  const agg = aggregateSessions(rows);
  assert.equal(agg.totalEmbedded, 3);
  assert.equal(agg.totalChunks, 22);
  assert.equal(agg.qualityDistribution['7-8'], 5);
  assert.equal(agg.qualityDistribution['9-10'], 9);
  assert.equal(agg.qualityDistribution['1-2'], 1);
  // embeddedOverTime buckets unique sessions per ISO week. Assert tz-independently:
  // every unique session is counted exactly once, and weeks are sorted ascending.
  const totalOverTime = agg.embeddedOverTime.reduce((s, w) => s + w.sessions, 0);
  assert.equal(totalOverTime, 3, 'each unique session counted once across weeks');
  const weeks = agg.embeddedOverTime.map(w => w.week);
  assert.deepEqual(weeks, [...weeks].sort(), 'weeks sorted ascending');
});

test('aggregateReflections totals, groups by failure type, and returns recent desc', () => {
  const rows = [
    { id: '1', date: '2026-06-01', failureType: 'X', failureDescription: 'd1', rootCause: '', preventionRule: '', sessionId: 'a' },
    { id: '2', date: '2026-06-03', failureType: 'X', failureDescription: 'd2', rootCause: '', preventionRule: '', sessionId: 'a' },
    { id: '3', date: '2026-06-02', failureType: 'Y', failureDescription: 'd3', rootCause: '', preventionRule: '', sessionId: 'b' },
  ];
  const agg = aggregateReflections(rows);
  assert.equal(agg.total, 3);
  assert.equal(agg.byFailureType.X, 2);
  assert.equal(agg.byFailureType.Y, 1);
  assert.equal(agg.recentReflections[0].date, '2026-06-03'); // newest first
  assert.equal(agg.recentReflections[2].date, '2026-06-01');
});

test('upsertSessionMetric merges independent patches (embedder chunks/date + scorer quality)', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-'));
  try {
    // Embedder writes chunks/date first…
    upsertSessionMetric(root, { sessionId: 'a', date: '2026-06-01T00:00:00Z', chunks: 12 });
    // …then the scorer fills in the quality histogram for the same session.
    upsertSessionMetric(root, { sessionId: 'a', scored: 12, quality: { '1-2': 0, '3-4': 0, '5-6': 0, '7-8': 2, '9-10': 10 } });
    const rows = readSessionMetrics(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chunks, 12, 'chunks preserved across the second patch');
    assert.equal(rows[0].date, '2026-06-01T00:00:00Z', 'date preserved');
    assert.equal(rows[0].quality['9-10'], 10, 'quality merged in');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('appendReflectionMetrics de-duplicates by id (idempotent)', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-'));
  try {
    const rec = { id: 'r1', date: '2026-06-01', failureType: 'X', failureDescription: 'd', rootCause: '', preventionRule: '', sessionId: 'a' };
    appendReflectionMetrics(root, [rec]);
    appendReflectionMetrics(root, [rec]); // same id again
    const rows = readReflectionMetrics(root);
    assert.equal(rows.length, 1, 'duplicate id not appended twice');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
