'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseBaseline, serializeBaseline, diff } = require('../../scripts/_lib/ratchet');

test('parseBaseline drops blanks and # comments', () => {
  const s = parseBaseline('# header\n\na\nb\n# mid\nc\n');
  assert.deepEqual([...s].sort(), ['a', 'b', 'c']);
});

test('serializeBaseline dedupes, sorts codepoint order, trailing newline', () => {
  assert.equal(serializeBaseline(['b', 'a', 'b', '', '  ']), 'a\nb\n');
  assert.equal(serializeBaseline([]), '');
});

test('diff: added = grew past baseline (violations), removed = shrank (safe)', () => {
  const { added, removed } = diff(new Set(['a', 'b', 'c']), new Set(['a', 'x']));
  assert.deepEqual(added, ['b', 'c']);
  assert.deepEqual(removed, ['x']);
});

test('diff accepts arrays or sets and is order-independent', () => {
  const { added, removed } = diff(['z', 'a'], ['a']);
  assert.deepEqual(added, ['z']);
  assert.deepEqual(removed, []);
});

test('round-trip: parse(serialize(x)) preserves the set', () => {
  const keys = ['one\tmsg', 'two\tmsg2'];
  assert.deepEqual([...parseBaseline(serializeBaseline(keys))].sort(), keys.slice().sort());
});
