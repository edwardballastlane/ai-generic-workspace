'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseConfig, shouldRun, verdictFrom, runGate, ANY_FILE } = require('../../scripts/_lib/verify-gate');

test('parseConfig normalizes commands + defaults', () => {
  const c = parseConfig('{"commands":[{"run":"npm test"}]}');
  assert.equal(c.commands[0].run, 'npm test');
  assert.equal(c.commands[0].name, 'npm test');   // name defaults to run
  assert.deepEqual(c.whenPathsChanged, []);
  assert.equal(c.timeoutMs, 180000);
});

test('parseConfig rejects empty/invalid', () => {
  assert.equal(parseConfig('not json'), null);
  assert.equal(parseConfig('{"commands":[]}'), null);
  assert.equal(parseConfig('{"commands":[{"name":"x"}]}'), null); // no run
});

test('shouldRun: no path filter → runs on any change', () => {
  const c = parseConfig('{"commands":[{"run":"t"}]}');
  assert.equal(shouldRun(c, ['/repo/a.js'], '/repo'), true);
  assert.equal(shouldRun(c, [], '/repo'), false);   // nothing changed
});

test('shouldRun: path filter matches by repo-relative prefix', () => {
  const c = parseConfig('{"commands":[{"run":"t"}],"whenPathsChanged":["scripts/","tests/"]}');
  assert.equal(shouldRun(c, ['/repo/scripts/x.js'], '/repo'), true);
  assert.equal(shouldRun(c, ['/repo/docs/x.md'], '/repo'), false);
  assert.equal(shouldRun(c, ['tests/y.test.js'], '/repo'), true);  // already relative
});

test('verdictFrom: PASS iff every command exited 0', () => {
  assert.equal(verdictFrom([{ name: 'a', code: 0 }, { name: 'b', code: 0 }]).verdict, 'PASS');
  const f = verdictFrom([{ name: 'a', code: 0 }, { name: 'b', code: 1 }]);
  assert.equal(f.verdict, 'FAIL');
  assert.deepEqual(f.failed, ['b']);
  assert.equal(verdictFrom([]).verdict, 'FAIL');   // nothing ran ≠ pass
});

test('runGate runs all commands via injected runner and aggregates', () => {
  const c = parseConfig('{"commands":[{"name":"tests","run":"npm test"},{"name":"lint","run":"npm run lint"}]}');
  const calls = [];
  const run = (cmd, opts) => { calls.push([cmd, opts.cwd]); return { code: cmd.includes('lint') ? 2 : 0 }; };
  const res = runGate('/repo', c, run);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], '/repo');
  assert.equal(res.verdict, 'FAIL');
  assert.deepEqual(res.failed, ['lint']);
});

test('runGate treats a runner throw as a failed command (never throws out)', () => {
  const c = parseConfig('{"commands":[{"run":"boom"}]}');
  const res = runGate('/repo', c, () => { throw new Error('spawn failed'); });
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.results[0].code, 1);
});

// --- ANY_FILE sentinel ----------------------------------------------------------
// A manual `verify-gate` run supplies no --files; the CLI passes [ANY_FILE] and the
// gate must RUN, not skip. Before this was handled, `npm run verify:gate` silently
// no-opped on every invocation.

test('shouldRun runs when the caller supplied no file filter (ANY_FILE)', () => {
  const config = parseConfig(JSON.stringify({
    commands: [{ name: 'tests', run: 'npm test' }],
    whenPathsChanged: ['scripts/', 'tests/'],
  }));
  assert.equal(shouldRun(config, [ANY_FILE], '/repo'), true);
});

test('ANY_FILE does not defeat an explicit, non-matching file filter', () => {
  const config = parseConfig(JSON.stringify({
    commands: [{ name: 'tests', run: 'npm test' }],
    whenPathsChanged: ['scripts/'],
  }));
  assert.equal(shouldRun(config, ['README.md'], '/repo'), false);
  assert.equal(shouldRun(config, ['scripts/a.js'], '/repo'), true);
});

test('ANY_FILE still respects an empty command list', () => {
  const config = parseConfig(JSON.stringify({ commands: [], whenPathsChanged: ['scripts/'] }));
  assert.equal(shouldRun(config, [ANY_FILE], '/repo'), false);
});
