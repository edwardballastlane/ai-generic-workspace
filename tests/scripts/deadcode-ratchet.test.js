'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deadcode-ratchet.js');

const BASELINE_HEADER = '# deadcode-ratchet baseline\n';

// A throwaway git repo, because the ratchet reads the git index (so its answer is
// identical locally and in CI) and cannot be exercised from pure-lib tests.
const TEMP_DIRS = [];
test.after(async () => {
  for (const dir of TEMP_DIRS) await fsp.rm(dir, { recursive: true, force: true });
});

async function gitRepo(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deadcode-cli-'));
  TEMP_DIRS.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text);
  }
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

function run(dir, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_ROOT: dir },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a doc that merely LISTS an orphan does not rescue it', async () => {
  // Regression: the port log names every frozen orphan as prose. Because .md is a
  // haystack extension, that made all of them look referenced — the ratchet
  // reported "0 unreferenced" and `--update` kept proposing to empty the baseline.
  // Writing an orphan down must not hide it.
  const dir = await gitRepo({
    'CLAUDE.md': '# repo\n',
    'scripts/orphan.js': "'use strict';\nmodule.exports = {};\n",
    'docs/reference/upstream-port.md': 'Ported, still unwired: `scripts/orphan.js`.\n',
    '.deadcode-baseline.txt': `${BASELINE_HEADER}scripts/orphan.js\n`,
  });

  const { code, out } = run(dir);
  assert.equal(code, 0, 'a frozen orphan must not fail the ratchet');
  assert.match(out, /1 unreferenced/, 'the orphan must still be COUNTED as unreferenced');
  assert.match(out, /1 frozen/);
  assert.match(out, /no new orphaned files/);
});

test('an ordinary doc that names a script still counts as a reference', async () => {
  const dir = await gitRepo({
    'CLAUDE.md': '# repo\n',
    'scripts/documented.js': "'use strict';\nmodule.exports = {};\n",
    'docs/usage.md': 'Run `node scripts/documented.js` to do the thing.\n',
    '.deadcode-baseline.txt': BASELINE_HEADER,
  });

  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /0 unreferenced/);
});

test('a new orphan not in the baseline fails the ratchet', async () => {
  const dir = await gitRepo({
    'CLAUDE.md': '# repo\n',
    'scripts/orphan.js': "'use strict';\nmodule.exports = {};\n",
    '.deadcode-baseline.txt': BASELINE_HEADER,
  });

  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /scripts\/orphan\.js/);
});

test('a file required by another script is alive', async () => {
  const dir = await gitRepo({
    'CLAUDE.md': '# repo\n',
    'scripts/helper.js': "'use strict';\nmodule.exports = {};\n",
    'scripts/main.js': "'use strict';\nrequire('./helper');\n",
    'package.json': JSON.stringify({ scripts: { go: 'node scripts/main.js' } }),
    '.deadcode-baseline.txt': BASELINE_HEADER,
  });

  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /0 unreferenced/);
});

test('--update rewrites the baseline to the current orphan set', async () => {
  const dir = await gitRepo({
    'CLAUDE.md': '# repo\n',
    'scripts/orphan.js': "'use strict';\nmodule.exports = {};\n",
    '.deadcode-baseline.txt': BASELINE_HEADER,
  });

  const r = run(dir, ['--update']);
  assert.equal(r.code, 0);
  const written = fs.readFileSync(path.join(dir, '.deadcode-baseline.txt'), 'utf8');
  assert.match(written, /^scripts\/orphan\.js$/m);
  assert.equal(run(dir).code, 0, 'the refreshed baseline must make the run green');
});
