'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyRefusal,
  evaluate,
  keyOf,
  baselineKeysFor,
  BY_DESIGN_VOCAB,
} = require('../../scripts/_lib/refusal-ratchet');
const { extractStringAt, extractRefusals } = require('../../scripts/refusal-ratchet');

test('classifyRefusal: actionable when a next step is named', () => {
  assert.equal(classifyRefusal({ message: 'Use /pre-push instead' }).actionable, true);
  assert.equal(classifyRefusal({ message: 'load from `${VAR}` instead' }).actionable, true);
  assert.equal(classifyRefusal({ message: 'export LANE_BLOCK_ENV_READS=1' }).actionable, true);
  assert.equal(classifyRefusal({ message: 'run `npm test`' }).actionable, true);
});

// The `run` and `instead` signals used to be bare-word matches, which let a dead
// end ("this cannot be run here") pass as actionable. These cases carry NO other
// signal — no backticks, no `use /`, no arrow — so only the tightened patterns
// decide, and loosening either one back re-breaks them.
test('classifyRefusal: "run" only counts when it names a runner', () => {
  assert.equal(classifyRefusal({ message: 'Please run npm test before retrying.' }).actionable, true);
  assert.equal(classifyRefusal({ message: 'This command cannot be run here.' }).actionable, false);
  assert.equal(classifyRefusal({ message: 'run the thing' }).actionable, false);
});

test('classifyRefusal: "instead" only counts after an imperative that points somewhere', () => {
  assert.equal(classifyRefusal({ message: 'Remove it or reference an env var (e.g. process.env.X) instead.' }).actionable, true);
  assert.equal(classifyRefusal({ message: 'Set the value in .env instead.' }).actionable, true);
  assert.equal(classifyRefusal({ message: 'Blocked by policy; the operation fails instead.' }).actionable, false);
});

test('classifyRefusal: the imperative must be near the "instead", not anywhere in the message', () => {
  assert.equal(classifyRefusal({ message: `use ${'x'.repeat(140)} instead` }).actionable, false);
});

test('classifyRefusal: dead-end when no next step and no marker', () => {
  const c = classifyRefusal({ message: 'Force push not allowed' });
  assert.equal(c.actionable, false);
  assert.equal(c.byDesign, false);
  assert.equal(c.deadEnd, true);
});

test('classifyRefusal: by-design marker with valid vocab clears the dead-end', () => {
  const c = classifyRefusal({ message: 'Force push not allowed', byDesignReason: 'human-authority' });
  assert.equal(c.byDesign, true);
  assert.equal(c.deadEnd, false);
  assert.equal(c.invalidByDesign, false);
});

test('classifyRefusal: unknown by-design reason is itself a violation', () => {
  const c = classifyRefusal({ message: 'nope', byDesignReason: 'because-i-said-so' });
  assert.equal(c.byDesign, false);
  assert.equal(c.invalidByDesign, true);
});

test('BY_DESIGN_VOCAB is the closed set', () => {
  assert.deepEqual([...BY_DESIGN_VOCAB].sort(),
    ['environment', 'human-authority', 'operator-knowledge', 'world-action']);
});

test('evaluate: new dead-end (not in baseline) is a violation', () => {
  const refusals = [{ file: 'a.js', message: 'just no' }];
  const res = evaluate(refusals, new Set());
  assert.equal(res.violations.length, 1);
});

test('evaluate: dead-end frozen in baseline is NOT a violation', () => {
  const refusals = [{ file: 'a.js', message: 'just no' }];
  const baseline = new Set([keyOf(refusals[0])]);
  const res = evaluate(refusals, baseline);
  assert.equal(res.violations.length, 0);
});

test('evaluate: actionable refusal never violates even if absent from baseline', () => {
  const res = evaluate([{ file: 'a.js', message: 'run `npm test`' }], new Set());
  assert.equal(res.violations.length, 0);
});

test('evaluate: reports baseline entries no longer present as removed', () => {
  const res = evaluate([], new Set(['gone.js\told refusal']));
  assert.deepEqual(res.removed, ['gone.js\told refusal']);
});

test('baselineKeysFor freezes only current dead-ends', () => {
  const keys = baselineKeysFor([
    { file: 'a.js', message: 'just no' },            // dead-end
    { file: 'a.js', message: 'run `npm test`' },     // actionable
    { file: 'a.js', message: 'nope', byDesignReason: 'human-authority' }, // by-design
  ]);
  assert.deepEqual(keys, ['a.js\tjust no']);
});

// --- extractor (from the CLI module) ---

test('extractStringAt handles single/double/backtick + escapes', () => {
  assert.equal(extractStringAt("block('hi')", 6), 'hi');
  assert.equal(extractStringAt('block("hi")', 6), 'hi');
  assert.equal(extractStringAt('block(`hi ${x}`)', 6), 'hi ${x}');
  assert.equal(extractStringAt("block('it\\'s')", 6), "it's");
  assert.equal(extractStringAt('block(x)', 6), null, 'non-string arg → null');
});

test('extractRefusals finds block() and throw new Error() with by-design markers', () => {
  const src = [
    "function block(r){}",
    "block('no next step here');",
    "// refusal:by-design human-authority",
    "block('cannot override');",
    "throw new Error('boom, run `npm run fix`');",
  ].join('\n');
  const found = extractRefusals('x.js', src);
  // 'function block(r){}' has no string arg → skipped; 3 real refusals
  const byMsg = Object.fromEntries(found.map((r) => [r.message, r]));
  assert.ok(byMsg['no next step here']);
  assert.equal(byMsg['cannot override'].byDesignReason, 'human-authority');
  assert.ok(byMsg['boom, run `npm run fix`']);
});
