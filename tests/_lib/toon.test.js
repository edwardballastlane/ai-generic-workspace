'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { encode, decode, fieldsOf } = require('../../scripts/_lib/toon');

const ROWS = [
  { id: 'obs_1', type: 'bugfix', title: 'Fix the thing', n: 3, ok: true },
  { id: 'obs_2', type: 'decision', title: 'Chose X, not Y', n: 0, ok: false },
];

test('encode: header names the array, count, and fields once', () => {
  const t = encode(ROWS, { name: 'results' });
  const head = t.split('\n')[0];
  assert.equal(head, 'results[2]{id,type,title,n,ok}:');
});

test('encode: values with commas are quoted; scalars are bare', () => {
  const t = encode(ROWS, { name: 'results' });
  assert.match(t, /obs_1,bugfix,Fix the thing,3,true/);
  assert.match(t, /obs_2,decision,"Chose X, not Y",0,false/);
});

test('round-trips: decode(encode(rows)) === rows (flat)', () => {
  assert.deepEqual(decode(encode(ROWS, { name: 'results' })), ROWS);
});

test('round-trips values with newlines and quotes', () => {
  const rows = [{ id: 'a', content: 'line1\nline2 with "quote" and, comma' }];
  assert.deepEqual(decode(encode(rows)), rows);
});

test('nested arrays/objects survive as JSON tokens', () => {
  const rows = [{ id: 'a', tags: ['x', 'y'], meta: { k: 1 } }];
  assert.deepEqual(decode(encode(rows)), rows);
});

test('null / missing fields → empty cell → null on decode', () => {
  const rows = [{ id: 'a', title: null }, { id: 'b', title: 'has' }];
  const back = decode(encode(rows));
  assert.equal(back[0].title, null);
  assert.equal(back[1].title, 'has');
});

test('empty array + malformed input', () => {
  assert.equal(encode([], { name: 'results' }), 'results[0]{}:');
  assert.deepEqual(decode('not toon'), []);
  assert.deepEqual(decode(''), []);
});

test('fieldsOf unions keys in first-seen order', () => {
  assert.deepEqual(fieldsOf([{ a: 1, b: 2 }, { b: 3, c: 4 }]), ['a', 'b', 'c']);
});

test('TOON is materially smaller than JSON on a realistic observation list', () => {
  // 6 observations with the memory-store field set — the mem_search hot path.
  const obs = Array.from({ length: 6 }, (_, i) => ({
    id: `obs_${i}`, type: 'bugfix', title: `Finding number ${i} about the widget`,
    project: 'api-service', source: 'agent', scope: 'project', ts: '2026-09-11T00:00:00Z',
  }));
  const json = JSON.stringify({ results: obs });
  const toon = encode(obs, { name: 'results' });
  const saved = 1 - toon.length / json.length;
  assert.ok(saved > 0.3, `expected >30% smaller, got ${(saved * 100).toFixed(0)}% (json ${json.length} → toon ${toon.length})`);
});
