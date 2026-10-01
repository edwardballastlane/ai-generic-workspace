'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { referenceTokens, isReferencedBy, computeDead } = require('../../scripts/_lib/deadcode-ratchet');

test('referenceTokens derives posix path, base, baseNoExt', () => {
  const t = referenceTokens('scripts/hooks/value-logger.js');
  assert.equal(t.posix, 'scripts/hooks/value-logger.js');
  assert.equal(t.base, 'value-logger.js');
  assert.equal(t.baseNoExt, 'value-logger');
});

test('isReferencedBy hits on full relpath (npm script / CI style)', () => {
  assert.equal(isReferencedBy('scripts/foo.js', 'run node scripts/foo.js now'), true);
});

test('isReferencedBy hits on basename-with-extension', () => {
  assert.equal(isReferencedBy('scripts/a/foo.js', 'somewhere foo.js is named'), true);
});

test('isReferencedBy hits on basename-no-ext as a word (relative require)', () => {
  assert.equal(isReferencedBy('scripts/_lib/cost.js', "const c = require('../_lib/cost');"), true);
});

test('isReferencedBy misses a true orphan', () => {
  assert.equal(isReferencedBy('scripts/orphan-xyz.js', 'nothing mentions it'), false);
});

test('isReferencedBy does not partial-match a longer word', () => {
  // "cost" should not be considered referenced by "accosting"
  assert.equal(isReferencedBy('scripts/cost.js', 'the word accosting appears'), false);
});

test('computeDead returns only unreferenced candidates, sorted', () => {
  const candidates = ['scripts/used.js', 'scripts/dead-one.js', 'scripts/dead-two.js'];
  const haystack = "require('./used')";
  assert.deepEqual(computeDead(candidates, haystack), ['scripts/dead-one.js', 'scripts/dead-two.js']);
});

test('computeDead tolerates empty input', () => {
  assert.deepEqual(computeDead(null, ''), []);
  assert.deepEqual(computeDead([], 'anything'), []);
});

test('computeDead (sources form): a file referenced by ANOTHER source is alive', () => {
  const candidates = ['scripts/a/qdrant-store.ts', 'scripts/a/orphan.ts'];
  const sources = [
    { rel: 'scripts/a/qdrant-store.ts', text: "// this file mentions qdrant-store itself" },
    { rel: 'scripts/a/factory.ts', text: "import { S } from './qdrant-store';" },
  ];
  // qdrant-store is imported by factory.ts (a different source) → alive.
  // orphan.ts is referenced by nobody → dead.
  assert.deepEqual(computeDead(candidates, sources), ['scripts/a/orphan.ts']);
});

test('computeDead (sources form): self-mention does NOT rescue a file', () => {
  const sources = [{ rel: 'scripts/lonely.ts', text: 'the word lonely appears in its own file' }];
  assert.deepEqual(computeDead(['scripts/lonely.ts'], sources), ['scripts/lonely.ts']);
});

test('isReferencedBy is the string-level check', () => {
  assert.equal(isReferencedBy('scripts/foo.js', "require('./foo')"), true);
});
