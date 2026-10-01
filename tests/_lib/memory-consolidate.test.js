'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decideWrite, normText } = require('../../scripts/_lib/memory-consolidate');

const obs = (o) => ({ type: 'bugfix', valid_to: null, revision: 0, ...o });

test('normText lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normText('  Fix   the SSE-bug!! '), 'fix the sse bug');
});

test('ADD when the store is empty', () => {
  assert.deepEqual(decideWrite(obs({ id: 'c', title: 'new thing' }), []), { action: 'add' });
});

test('ADD when titles differ (distinct findings)', () => {
  const existing = [obs({ id: 'e1', title: 'first finding' })];
  assert.equal(decideWrite(obs({ id: 'c', title: 'second finding' }), existing).action, 'add');
});

test('NOOP on identical normalized title+content of same type', () => {
  const existing = [obs({ id: 'e1', title: 'Cache bug', content: 'in redis.' })];
  const d = decideWrite(obs({ id: 'c', title: 'cache  bug', content: 'IN redis' }), existing);
  assert.equal(d.action, 'noop');
  assert.equal(d.targetId, 'e1');
});

test('SUPERSEDE when title matches but content evolved; revision increments', () => {
  const existing = [obs({ id: 'e1', title: 'ThemeConfig sites', content: 'two sites', revision: 0 })];
  const d = decideWrite(obs({ id: 'c', title: 'ThemeConfig sites', content: 'actually three sites' }), existing);
  assert.equal(d.action, 'supersede');
  assert.equal(d.targetId, 'e1');
  assert.equal(d.revision, 1);
});

test('does not consolidate across different types', () => {
  const existing = [obs({ id: 'e1', type: 'decision', title: 'same title' })];
  assert.equal(decideWrite(obs({ id: 'c', type: 'bugfix', title: 'same title' }), existing).action, 'add');
});

test('ignores already-superseded records as targets', () => {
  const existing = [obs({ id: 'e1', title: 'x', content: 'a', valid_to: '2026-01-01T00:00:00Z' })];
  assert.equal(decideWrite(obs({ id: 'c', title: 'x', content: 'b' }), existing).action, 'add');
});

test('excludes self by id (re-normalizing the same record is not a supersede)', () => {
  const existing = [obs({ id: 'same', title: 'x', content: 'a' })];
  assert.equal(decideWrite(obs({ id: 'same', title: 'x', content: 'b' }), existing).action, 'add');
});

test('SUPERSEDE targets the NEWEST matching prior version', () => {
  const existing = [
    obs({ id: 'old', title: 'T', content: 'v1', ts: '2026-01-01T00:00:00Z' }),
    obs({ id: 'mid', title: 'T', content: 'v2', ts: '2026-02-01T00:00:00Z' }),
  ];
  const d = decideWrite(obs({ id: 'c', title: 'T', content: 'v3', ts: '2026-03-01T00:00:00Z' }), existing);
  assert.equal(d.action, 'supersede');
  assert.equal(d.targetId, 'mid');
});

test('candidate without a title is always ADD', () => {
  assert.equal(decideWrite(obs({ id: 'c', title: '' }), [obs({ id: 'e', title: '' })]).action, 'add');
});
