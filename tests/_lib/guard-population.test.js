'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractGuards, keyOf, sha256, MARKER_RE } = require('../../scripts/_lib/guard-population');

const SAMPLE = [
  "if (tool === 'Bash') {",
  "  // guard:population force-push fail-closed: block --force to main",
  "  if (FORCE.test(cmd)) {",
  "    block('no force push');",
  "  }",
  "  // guard:population secret too-tight: block secrets",
  "  if (looksSecret(cmd)) {",
  "    block('secret');",
  "  }",
  "}",
].join('\n');

test('extractGuards finds each marker with family/direction/reason', () => {
  const g = extractGuards(SAMPLE, 'x.js');
  assert.equal(g.length, 2);
  assert.equal(g[0].family, 'force-push');
  assert.equal(g[0].direction, 'fail-closed');
  assert.match(g[0].reason, /block --force/);
  assert.equal(g[1].family, 'secret');
  assert.equal(g[1].direction, 'too-tight');
});

test('each guard gets a stable non-empty fingerprint', () => {
  const g = extractGuards(SAMPLE, 'x.js');
  // 128 bits, hardcoded on purpose: silently shortening the fingerprint of a
  // tamper-evident registry should fail this test, not quietly track the source.
  assert.match(g[0].sha, /^[0-9a-f]{32}$/);
  assert.notEqual(g[0].sha, g[1].sha);
  // deterministic
  assert.equal(extractGuards(SAMPLE, 'x.js')[0].sha, g[0].sha);
});

test('altering guarded logic changes the fingerprint (tamper-evident)', () => {
  const before = extractGuards(SAMPLE, 'x.js')[0].sha;
  const tampered = SAMPLE.replace("if (FORCE.test(cmd)) {", "if (FORCE.test(cmd) || allowAnyway) {");
  const after = extractGuards(tampered, 'x.js')[0].sha;
  assert.notEqual(before, after);
});

test('keyOf pins file, family, direction, and sha', () => {
  const g = { file: 'x.js', family: 'f', direction: 'fail-closed', sha: 'abc' };
  assert.equal(keyOf(g), 'x.js\tf\tfail-closed\tabc');
});

test('a bad direction is not recognized as a guard marker', () => {
  assert.equal(extractGuards('// guard:population fam sideways: x\nblock(1)', 'x.js').length, 0);
});

test('MARKER_RE requires the guard:population prefix', () => {
  assert.equal(MARKER_RE.test('// just a comment'), false);
  assert.equal(MARKER_RE.test('// guard:population fam fail-closed: ok'), true);
});
