'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sha256, buildRecord, verifyRecord } = require('../../scripts/_lib/evidence');

test('buildRecord hashes the output and records metadata', () => {
  const rec = buildRecord({ taskId: 'T1', criterionId: 'AC1', command: 'jest', exitCode: 0, output: '3 passed', assertion: '3 passed' });
  assert.equal(rec.sha256, sha256(Buffer.from('3 passed', 'utf8')));
  assert.equal(rec.bytes, 8);
  assert.equal(rec.exitCode, 0);
});

test('verifyRecord passes on identical artifact + exit 0 + present assertion', () => {
  const rec = buildRecord({ taskId: 'T1', criterionId: 'AC1', command: 'jest', exitCode: 0, output: 'Tests: 3 passed, 0 failed', assertion: '3 passed' });
  assert.deepEqual(verifyRecord(rec, 'Tests: 3 passed, 0 failed'), { ok: true, errors: [] });
});

test('verifyRecord fails on a tampered artifact (sha mismatch)', () => {
  const rec = buildRecord({ taskId: 'T1', criterionId: 'AC1', command: 'jest', exitCode: 0, output: '3 passed' });
  const v = verifyRecord(rec, '4 passed');
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /sha256 mismatch/);
});

test('verifyRecord fails on a non-zero exit code', () => {
  const rec = buildRecord({ taskId: 'T1', criterionId: 'AC1', command: 'jest', exitCode: 1, output: 'boom' });
  const v = verifyRecord(rec, 'boom');
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /non-zero/);
});

test('verifyRecord rejects a hollow green — exit 0 but assertion absent', () => {
  // exit 0 but "0 tests collected" — the false positive an exit-code-only gate misses.
  const rec = buildRecord({ taskId: 'T1', criterionId: 'AC1', command: 'jest', exitCode: 0, output: 'No tests found, exiting with code 0', assertion: 'passed' });
  const v = verifyRecord(rec, 'No tests found, exiting with code 0');
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /assertion not found/);
});

test('no assertion means only sha + exit are checked', () => {
  const rec = buildRecord({ taskId: 'T1', criterionId: 'AC1', command: 'x', exitCode: 0, output: 'anything' });
  assert.equal(verifyRecord(rec, 'anything').ok, true);
});
