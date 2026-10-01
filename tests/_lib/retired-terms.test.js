'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTerms, findRetired } = require('../../scripts/_lib/retired-terms');

test('parseTerms drops blanks and # comments', () => {
  assert.deepEqual(parseTerms('# header\n\nlast_message_preview\n# note\noldThing\n'), ['last_message_preview', 'oldThing']);
});

test('findRetired reports file + term + line for each reappearance', () => {
  const sources = [
    { file: 'scripts/hooks/x.js', text: 'const a = 1;\nconst last_message_preview = 2;' },
    { file: 'scripts/y.js', text: 'clean file' },
  ];
  const hits = findRetired(sources, ['last_message_preview']);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { file: 'scripts/hooks/x.js', term: 'last_message_preview', line: 2 });
});

test('no reappearance → no hits', () => {
  assert.deepEqual(findRetired([{ file: 'a.js', text: 'nothing here' }], ['gone_term']), []);
});

test('tolerates empty inputs', () => {
  assert.deepEqual(findRetired(null, ['x']), []);
  assert.deepEqual(findRetired([{ file: 'a', text: 'x' }], null), []);
});

test('the seeded registry does not appear in active source (real guard passes)', () => {
  // Mirrors the CLI: last_message_preview must not be in active .js/.ts (docs/tests/logs ok).
  const { trackedActiveSources } = require('../../scripts/retired-terms');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '../..');
  let terms = [];
  try { terms = parseTerms(fs.readFileSync(path.join(root, '.retired-terms.txt'), 'utf8')); } catch { return; }
  const hits = findRetired(trackedActiveSources(root), terms);
  assert.deepEqual(hits, [], `retired terms reappeared in active source: ${JSON.stringify(hits)}`);
});
