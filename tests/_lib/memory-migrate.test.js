'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  ruleToObservation, rulesToObservations, parseMemoryIndex, memoryFileToObservation,
} = require('../../scripts/_lib/memory-migrate');

test('ruleToObservation maps a rule to a pattern observation', () => {
  const o = ruleToObservation({
    id: 'r1', text: 'Always run the full suite before marking a task complete',
    categories: ['testing'], projects: ['api-service'], createdAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(o.id, 'rule:r1');
  assert.equal(o.type, 'pattern');
  assert.equal(o.ts, '2026-01-01T00:00:00Z');
  assert.deepEqual(o.tags, ['testing']);
  assert.equal(o.project, 'api-service');
  assert.equal(o.source, 'rules-shared');
});

test('ruleToObservation truncates a long title but keeps full content', () => {
  const text = 'x'.repeat(300);
  const o = ruleToObservation({ id: 'r2', text });
  assert.ok(o.title.length <= 120);
  assert.ok(o.title.endsWith('…'));
  assert.equal(o.content, text);
});

test('ruleToObservation returns null for invalid input', () => {
  assert.equal(ruleToObservation(null), null);
  assert.equal(ruleToObservation({ id: 'x' }), null); // no text
  assert.equal(ruleToObservation({ text: 'x' }), null); // no id
});

test('rulesToObservations filters to active by default', () => {
  const obs = rulesToObservations([
    { id: 'a', text: 'one', status: 'active' },
    { id: 'b', text: 'two', status: 'demoted' },
    { id: 'c', text: 'three' }, // no status → treated active
  ]);
  assert.deepEqual(obs.map((o) => o.id), ['rule:a', 'rule:c']);
});

test('parseMemoryIndex parses index lines with — or - and optional hook', () => {
  const md = [
    '# Memory Index',
    '- [Perf swarm](proj-123-perf-swarm.md) — 18-task outcome',
    '- [Plain One](plain.md)',
    'not an entry',
  ].join('\n');
  const entries = parseMemoryIndex(md);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { title: 'Perf swarm', file: 'proj-123-perf-swarm.md', hook: '18-task outcome' });
  assert.equal(entries[1].hook, '');
});

test('memoryFileToObservation keys id on slug and prefers body', () => {
  const o = memoryFileToObservation({ title: 'T', file: 'my-note.md', hook: 'h' }, '# body');
  assert.equal(o.id, 'memory:my-note');
  assert.equal(o.type, 'decision');
  assert.equal(o.content, '# body');
  assert.equal(o.source, 'MEMORY.md');
});

test('memoryFileToObservation falls back to hook when body empty', () => {
  const o = memoryFileToObservation({ title: 'T', file: 'x.md', hook: 'the hook' }, '');
  assert.equal(o.content, 'the hook');
});
