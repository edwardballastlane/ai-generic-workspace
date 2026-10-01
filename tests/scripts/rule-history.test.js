'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TSCONFIG = path.join(ROOT, 'tsconfig.json');
// Invoke the LOCALLY-installed ts-node binary under the same Node, never `npx ts-node`. npx resolves
// against the cwd's node_modules and, when a test redirects HOME to an isolated temp dir (see the
// git-config-fallback test), can't find the project install — so it installs a fresh ts-node WITHOUT its
// `typescript` peer into the temp HOME, and ts-node crashes with `Cannot read properties of undefined
// (reading 'fileExists')` (ts.sys undefined). Resolving the bin from ROOT sidesteps npx entirely: no
// network, no cache warmth, no HOME sensitivity — the CI failure this test hit.
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js', { paths: [ROOT] });

function runTsEval(code, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [TS_NODE_BIN, '--project', TSCONFIG, '-e', code],
    {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
    },
  );
}

test('getActor reads git config user.name and user.email', () => {
  const code = `
    import { getActor } from './scripts/self-improvement/rule-history';
    const a = getActor();
    process.stdout.write(JSON.stringify(a));
  `;
  const r = runTsEval(code);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const actor = JSON.parse(r.stdout.trim());
  assert.ok(typeof actor.name === 'string' && actor.name.length > 0, 'actor.name present');
  assert.ok(typeof actor.email === 'string', 'actor.email present (may be empty)');
});

test('appendHistory pushes events with timestamp, event kind, actor, and detail', () => {
  const code = `
    import { appendHistory } from './scripts/self-improvement/rule-history';
    import type { Rule } from './scripts/self-improvement/types';
    const rule: Rule = {
      id: 'test', text: 'demo', source: 'manual', status: 'active',
      reinforcementCount: 0,
      createdAt: '2026-05-15T00:00:00Z',
      lastReinforced: '2026-05-15T00:00:00Z',
      sourceSessionIds: [],
    };
    appendHistory(rule, 'created', 'unit test');
    appendHistory(rule, 'reinforced', '+5');
    appendHistory(rule, 'retired', 'stale');
    process.stdout.write(JSON.stringify(rule.history));
  `;
  const r = runTsEval(code);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const history = JSON.parse(r.stdout.trim());
  assert.equal(history.length, 3);
  assert.equal(history[0].event, 'created');
  assert.equal(history[0].detail, 'unit test');
  assert.ok(history[0].actor && history[0].actor.name, 'actor recorded');
  assert.equal(history[1].event, 'reinforced');
  assert.equal(history[1].detail, '+5');
  assert.equal(history[2].event, 'retired');
  for (const h of history) {
    assert.match(h.at, /^\d{4}-\d{2}-\d{2}T/, 'timestamp is ISO 8601');
  }
});

test('getActor falls back to USER env when git config is unset', async () => {
  // Run in an empty cwd with HOME pointed at an empty dir so git config has
  // nothing to read. USER is preserved so the fallback should kick in.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rule-history-'));
  try {
    fs.writeFileSync(path.join(tmp, '.gitconfig'), '');
    const code = `
      import { getActor } from '${path.join(ROOT, 'scripts/self-improvement/rule-history').replace(/\\\\/g, '/')}';
      process.stdout.write(JSON.stringify(getActor()));
    `;
    const r = spawnSync(
      process.execPath,
      [TS_NODE_BIN, '--project', TSCONFIG, '-e', code],
      {
        encoding: 'utf8',
        cwd: tmp,
        env: {
          ...process.env,
          HOME: tmp,
          USER: 'test-user-fallback',
          GIT_CONFIG_GLOBAL: path.join(tmp, '.gitconfig'),
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const actor = JSON.parse(r.stdout.trim());
    assert.equal(actor.name, 'test-user-fallback');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
