'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { aggregate, dayOf } = require('../../scripts/_lib/memory-board');

const OBS = [
  { contributor: 'juan', type: 'decision', ts: '2026-08-13T10:00:00Z', project: 'api-service', title: 'A' },
  { contributor: 'juan', type: 'bugfix', ts: '2026-08-14T10:00:00Z', project: 'api-service', title: 'B' },
  { contributor: 'pato', type: 'session_summary', ts: '2026-08-14T09:00:00Z', project: '', title: 'C' },
  { contributor: 'pato', type: 'session_summary', ts: '2026-08-15T09:00:00Z', project: 'web-app', title: 'D' },
  { contributor: 'pato', type: 'decision', ts: '2026-08-15T11:00:00Z', project: 'web-app', title: 'E' },
];

test('dayOf slices the date', () => {
  assert.equal(dayOf('2026-08-13T10:00:00Z'), '2026-08-13');
  assert.equal(dayOf(''), '');
});

test('totals, contributor count, and span', () => {
  const a = aggregate(OBS);
  assert.equal(a.totalObs, 5);
  assert.equal(a.contributorCount, 2);
  assert.deepEqual(a.span, { first: '2026-08-13', last: '2026-08-15' });
});

test('byType and byProject counts (unset project bucketed)', () => {
  const a = aggregate(OBS);
  assert.deepEqual(a.byType, { decision: 2, bugfix: 1, session_summary: 2 });
  assert.equal(a.byProject['web-app'], 2);
  assert.equal(a.byProject['(unset)'], 1);
});

test('contributors sorted by count desc, with per-contributor types + span', () => {
  const a = aggregate(OBS);
  assert.deepEqual(a.contributors.map((c) => c.name), ['pato', 'juan']);
  assert.equal(a.contributors[0].count, 3);
  assert.deepEqual(a.contributors[1].types, { decision: 1, bugfix: 1 });
  assert.equal(a.contributors[0].last, '2026-08-15T11:00:00Z');
});

test('timeline is chronological with per-day counts', () => {
  const a = aggregate(OBS);
  assert.deepEqual(a.timeline, [
    { day: '2026-08-13', count: 1 },
    { day: '2026-08-14', count: 2 },
    { day: '2026-08-15', count: 2 },
  ]);
});

test('recent is newest-first and limit-bounded', () => {
  const a = aggregate(OBS, { recentLimit: 2 });
  assert.equal(a.recent.length, 2);
  assert.equal(a.recent[0].title, 'E'); // 08-15 11:00 newest
});

test('tolerates empty / junk input', () => {
  const a = aggregate(null);
  assert.equal(a.totalObs, 0);
  assert.equal(a.contributorCount, 0);
  assert.deepEqual(a.timeline, []);
});
