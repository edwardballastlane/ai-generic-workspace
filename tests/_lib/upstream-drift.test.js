'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  computeDrift,
  listTracked,
  addedLines,
  matchTerms,
  toRegexes,
  area,
  isComparable,
} = require('../../scripts/_lib/upstream-drift');

async function makeWorkspaces(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drift-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const CONFIG = {
  projectTerms: ['acme', 'ACME-[0-9]{3,}'],
  track: ['scripts', '.claude/commands'],
  ignore: ['(^|/)node_modules(/|$)'],
};

test('computeDrift splits missing files into portable and project-specific', async () => {
  const upstream = await makeWorkspaces({
    'scripts/portable.js': 'module.exports = 1;\n',
    'scripts/coupled.js': '// acme-only helper for ACME-1234\n',
    'scripts/shared.js': 'const a = 1;\n',
  });
  const local = await makeWorkspaces({ 'scripts/shared.js': 'const a = 1;\n' });

  const r = computeDrift(upstream, local, CONFIG);
  const byPath = Object.fromEntries(r.missing.map((f) => [f.path, f]));

  assert.equal(r.missing.length, 2);
  assert.equal(byPath['scripts/portable.js'].kind, 'portable');
  assert.equal(byPath['scripts/coupled.js'].kind, 'project-specific');
  assert.deepEqual(
    byPath['scripts/coupled.js'].terms.map((t) => t.term).sort(),
    ['ACME-[0-9]{3,}', 'acme'],
  );
  assert.equal(r.drifted.length, 0);
});

test('computeDrift classifies drift by the terms in upstream-only lines', async () => {
  const upstream = await makeWorkspaces({
    'scripts/a.js': 'const a = 1;\nconst b = 2;\n',
    'scripts/b.js': 'const a = 1;\nconst acmeFlag = true;\n',
  });
  const local = await makeWorkspaces({
    'scripts/a.js': 'const a = 1;\n',
    'scripts/b.js': 'const a = 1;\n',
  });

  const r = computeDrift(upstream, local, CONFIG);
  const byPath = Object.fromEntries(r.drifted.map((f) => [f.path, f]));

  assert.equal(r.drifted.length, 2);
  assert.equal(byPath['scripts/a.js'].kind, 'portable');
  assert.equal(byPath['scripts/a.js'].addedLines, 1);
  assert.equal(byPath['scripts/b.js'].kind, 'project-specific');
});

test('computeDrift reports local-only files and skips identical ones', async () => {
  const upstream = await makeWorkspaces({ 'scripts/same.js': 'x\n' });
  const local = await makeWorkspaces({ 'scripts/same.js': 'x\n', 'scripts/mine.js': 'y\n' });

  const r = computeDrift(upstream, local, CONFIG);
  assert.equal(r.drifted.length, 0);
  assert.equal(r.missing.length, 0);
  assert.deepEqual(r.localOnly.map((f) => f.path), ['scripts/mine.js']);
});

test('listTracked honours ignore patterns and untracked directories', async () => {
  const root = await makeWorkspaces({
    'scripts/keep.js': 'a\n',
    'scripts/node_modules/dep/index.js': 'a\n',
    'docs/skip.md': 'a\n',
  });
  const ignoreRes = CONFIG.ignore.map((p) => new RegExp(p));
  const tracked = listTracked(root, CONFIG.track, ignoreRes);
  assert.deepEqual([...tracked], ['scripts/keep.js']);
});

test('areas summary counts each file once in its bucket', async () => {
  const upstream = await makeWorkspaces({
    'scripts/new.js': 'a\n',
    '.claude/commands/acme.md': 'acme\n',
  });
  const local = await makeWorkspaces({});
  const r = computeDrift(upstream, local, CONFIG);

  assert.equal(r.areas.scripts.portableMissing, 1);
  assert.equal(r.areas['.claude/commands'].projectMissing, 1);
});

test('addedLines returns trimmed upstream lines absent locally', () => {
  assert.deepEqual(addedLines('  a\nb\nc\n', 'a\nc\n'), ['b']);
  assert.deepEqual(addedLines('a\n\n', 'a\n'), []);
});

test('matchTerms counts every occurrence case-insensitively', () => {
  const hits = matchTerms('Acme and acme', toRegexes(['acme']));
  assert.deepEqual(hits, [{ term: 'acme', count: 2 }]);
  assert.deepEqual(matchTerms('nothing', toRegexes(['acme'])), []);
});

test('area groups by up to two path segments', () => {
  assert.equal(area('package.json'), '(root)');
  assert.equal(area('scripts/foo.js'), 'scripts');
  assert.equal(area('scripts/_lib/foo.js'), 'scripts/_lib');
  assert.equal(area('scripts/_lib/deep/foo.js'), 'scripts/_lib');
});

test('isComparable rejects binary extensions', () => {
  assert.equal(isComparable('a/b.js'), true);
  assert.equal(isComparable('a/b.md'), true);
  assert.equal(isComparable('a/b.png'), false);
});

test('toRegexes: a bare term is case-insensitive', () => {
  const regexes = toRegexes(['acmecorp']);
  assert.equal(matchTerms('The Acmecorp workspace', regexes).length, 1);
});

test('toRegexes: /pattern/flags supplies its own flags, so a term can be case-SENSITIVE', () => {
  // An uppercase ticket prefix case-folded matches ordinary identifiers
  // (`const xyz = ...`), which buries the gate in false positives. Neutral
  // stand-in terms on purpose: this file is scanned by the gate it tests.
  const regexes = toRegexes(['/\\bXYZ\\b/g']);
  assert.equal(matchTerms('const xyz = lookup.get(i);', regexes).length, 0);
  assert.equal(matchTerms('project = XYZ AND status = Done', regexes).length, 1);
});

test('toRegexes: explicit form always gets the global flag, so counts are accurate', () => {
  const regexes = toRegexes(['/\\bXYZ\\b/i']);
  assert.equal(matchTerms('XYZ and xyz and XYZ', regexes)[0].count, 3);
});

test('toRegexes: a path-shaped term stays literal and case-insensitive', () => {
  // Flags are required after the closing slash precisely so `/opt/acme/` is not
  // mistaken for a regex literal — that would strip the delimiters and silently
  // drop the `i`, and projectTerms already carries path-shaped entries.
  const regexes = toRegexes(['/opt/acme/']);
  assert.equal(matchTerms('see /OPT/ACME/ here', regexes).length, 1);
});

test('toRegexes: a malformed term names itself instead of throwing a bare SyntaxError', () => {
  assert.throws(() => toRegexes(['/[unclosed/g']), /projectTerms entry .* is not a valid regex/);
});
