'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  isPass,
  recentWindow,
  detectTheater,
  detectByGroup,
  DEFAULTS,
} = require('../../scripts/_lib/gate-theater');

const pass = (n) => Array.from({ length: n }, () => ({ verdict: 'PASS' }));
const fail = (n) => Array.from({ length: n }, () => ({ verdict: 'FAIL' }));

test('isPass normalizes verdict shapes and casing', () => {
  assert.equal(isPass('PASS'), true);
  assert.equal(isPass('pass'), true);
  assert.equal(isPass('ACCEPTED'), true);
  assert.equal(isPass({ verdict: 'Pass' }), true);
  assert.equal(isPass('FAIL'), false);
  assert.equal(isPass({ verdict: 'FAIL: broke it' }), false);
  assert.equal(isPass(null), false);
  assert.equal(isPass(undefined), false);
});

test('recentWindow keeps the most recent N in order', () => {
  const arr = [1, 2, 3, 4, 5].map((n) => ({ verdict: 'PASS', n }));
  assert.deepEqual(recentWindow(arr, 2).map((v) => v.n), [4, 5]);
  assert.equal(recentWindow(arr, 0).length, 5, 'windowSize 0 = all');
  assert.equal(recentWindow(arr, null).length, 5, 'null = all');
  assert.equal(recentWindow('not-an-array', 3).length, 0);
});

test('insufficient data never flags theater', () => {
  const r = detectTheater(pass(5), { minDecisions: 8 });
  assert.equal(r.theater, false);
  assert.equal(r.reason, 'insufficient-data');
  assert.equal(r.decisions, 5);
});

test('a gate that never fails over enough decisions is flagged never-fails', () => {
  const r = detectTheater(pass(12), { minDecisions: 8 });
  assert.equal(r.theater, true);
  assert.equal(r.reason, 'never-fails');
  assert.equal(r.fails, 0);
  assert.equal(r.passRate, 1);
});

test('pass-rate at/above threshold (but with some fails) is theater', () => {
  // 19 pass / 1 fail = 0.95 exactly ⇒ theater at default threshold
  const r = detectTheater([...pass(19), ...fail(1)], { minDecisions: 8, rateThreshold: 0.95, windowSize: 0 });
  assert.equal(r.theater, true);
  assert.equal(r.reason, 'pass-rate-above-threshold');
  assert.ok(Math.abs(r.passRate - 0.95) < 1e-9);
});

test('a gate that fails regularly is healthy', () => {
  const r = detectTheater([...pass(7), ...fail(3)], { minDecisions: 8, rateThreshold: 0.95, windowSize: 0 });
  assert.equal(r.theater, false);
  assert.equal(r.reason, 'healthy');
  assert.equal(r.passRate, 0.7);
});

test('window bounds the evaluation to recent decisions', () => {
  // Old history is all fails; recent window is all pass ⇒ theater on the window
  const verdicts = [...fail(50), ...pass(10)];
  const r = detectTheater(verdicts, { minDecisions: 8, windowSize: 10 });
  assert.equal(r.decisions, 10);
  assert.equal(r.theater, true);
  assert.equal(r.reason, 'never-fails');
});

test('detectByGroup isolates an always-PASS slice from healthy ones', () => {
  const verdicts = [
    ...pass(10).map((v) => ({ ...v, project: 'rubber' })),
    ...[...pass(6), ...fail(4)].map((v) => ({ ...v, project: 'healthy' })),
  ];
  const byProject = detectByGroup(verdicts, (v) => v.project, { minDecisions: 8, windowSize: 0 });
  assert.equal(byProject.rubber.theater, true, 'always-pass project flagged');
  assert.equal(byProject.healthy.theater, false, 'mixed project stays healthy');
});

test('detectByGroup buckets unknown keys and tolerates junk input', () => {
  const byPanel = detectByGroup(null, (v) => v.panel);
  assert.deepEqual(byPanel, {});
  const grouped = detectByGroup([{ verdict: 'PASS' }], (v) => v.panel, { minDecisions: 1 });
  assert.ok('unknown' in grouped);
});

test('DEFAULTS are frozen and sane', () => {
  assert.throws(() => { DEFAULTS.minDecisions = 1; }, TypeError);
  assert.ok(DEFAULTS.rateThreshold > 0.5 && DEFAULTS.rateThreshold <= 1);
});
