'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parsePrFromCmd, buildPrSummary, sessionSummaryId } = require('../../scripts/_lib/pr-summary');

test('parses gh pr create --title/--body', () => {
  const r = parsePrFromCmd('gh pr create --title "Fix SSE ordering" --body "Root cause: race in emitter"');
  assert.equal(r.title, 'Fix SSE ordering');
  assert.equal(r.body, 'Root cause: race in emitter');
});

test('parses glab/az --description as body', () => {
  assert.equal(parsePrFromCmd('glab mr create --title "T" --description "D"').body, 'D');
  assert.equal(parsePrFromCmd('az repos pr create --title "T" --description "D"').body, 'D');
});

test('parses --flag=value form', () => {
  const r = parsePrFromCmd('gh pr create --title=Quick --body=Done');
  assert.equal(r.title, 'Quick');
  assert.equal(r.body, 'Done');
});

test('parses positional bitbucket-pr create title+desc', () => {
  const r = parsePrFromCmd('scripts/bitbucket-pr create proj api-service feature/PROJ-1 staging "fix(PROJ-1): thing" "Problem/Fix body" false true');
  assert.equal(r.title, 'fix(PROJ-1): thing');
  assert.equal(r.body, 'Problem/Fix body');
});

test('buildPrSummary composes title + ticket + project + files + body', () => {
  const s = buildPrSummary({
    cmd: 'gh pr create --title "Add dark mode" --body "Palette from mockup"',
    ticket: 'PROJ-14216', project: 'web-app',
    filesTouched: ['a.js', 'b.js'],
  });
  assert.equal(s.title, 'Add dark mode');
  assert.match(s.content, /PR: Add dark mode/);
  assert.match(s.content, /Ticket: PROJ-14216/);
  assert.match(s.content, /Project: web-app/);
  assert.match(s.content, /Files: a\.js, b\.js/);
  assert.match(s.content, /Palette from mockup/);
});

test('buildPrSummary truncates the files list past 15', () => {
  const files = Array.from({ length: 20 }, (_, i) => `f${i}.js`);
  const s = buildPrSummary({ cmd: 'gh pr create --title "Big" --body "x"', filesTouched: files });
  assert.match(s.content, /\(\+5 more\)/);
});

test('buildPrSummary returns null when no usable title (e.g. --body-file only)', () => {
  assert.equal(buildPrSummary({ cmd: 'gh pr create --body-file /tmp/b.md' }), null);
});

test('sessionSummaryId is deterministic per session', () => {
  assert.equal(sessionSummaryId('abc'), 'sess_abc');
});
