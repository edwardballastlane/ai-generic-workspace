'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { verdictOf, parseVerdict, normalizeVerdict } = require('../../scripts/_lib/verdict');

test('verdictOf recognizes PASS / FAIL lines (incl. bold + VERDICT: prefix)', () => {
  assert.equal(verdictOf('PASS'), 'PASS');
  assert.equal(verdictOf('**FAIL: broke the build**'), 'FAIL');
  assert.equal(verdictOf('VERDICT: pass'), 'PASS');
  assert.equal(verdictOf('this passes review'), null); // not a verdict declaration
});

test('parseVerdict anchors to the FINAL verdict line', () => {
  const r = parseVerdict('preamble\nPASS\nmore notes\nFAIL: actually broken');
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.matches, 2);
});

test('inline verdict mentions in prose are ignored (only line-anchored tokens count)', () => {
  // The rubric-quote line does NOT start with a verdict token → not counted.
  const r = parseVerdict('the rubric says output "PASS" or "FAIL"\nPASS');
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.matches, 1);
  assert.equal(r.parseState, 'ok');
});

test('parseVerdict flags ambiguous when two distinct verdict LINES appear (echoed example)', () => {
  // A critic echoes an example verdict line, then emits a real one that conflicts.
  const r = parseVerdict('PASS\n...reasoning...\nFAIL: actually a blocker');
  assert.equal(r.parseState, 'ambiguous');
  assert.equal(r.verdict, 'FAIL'); // still anchored to the final line
});

test('parseVerdict: single clean verdict → ok; none → no_verdict', () => {
  assert.deepEqual(parseVerdict('PASS'), { verdict: 'PASS', parseState: 'ok', matches: 1 });
  assert.deepEqual(parseVerdict('no verdict here'), { verdict: null, parseState: 'no_verdict', matches: 0 });
});

test('normalizeVerdict upgrades PASS with a blocker → FAIL', () => {
  const r = normalizeVerdict({ verdict: 'PASS', blockers: 1 });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.raw, 'PASS');
  assert.equal(r.normalized, true);
  assert.match(r.reason, /upgraded/);
});

test('normalizeVerdict floors FAIL with no blocker/major → PASS', () => {
  const r = normalizeVerdict({ verdict: 'FAIL', blockers: 0, majors: 0 });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.raw, 'FAIL');
  assert.match(r.reason, /floored/);
});

test('normalizeVerdict leaves consistent verdicts unchanged', () => {
  assert.equal(normalizeVerdict({ verdict: 'PASS', blockers: 0 }).normalized, false);
  assert.equal(normalizeVerdict({ verdict: 'FAIL', blockers: 2 }).normalized, false);
  assert.equal(normalizeVerdict({ verdict: 'FAIL', blockers: 0, majors: 1 }).verdict, 'FAIL'); // a major keeps the fail
});
