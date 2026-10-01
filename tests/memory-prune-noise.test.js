'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneJsonl } = require('../scripts/memory-prune-noise');

// A workspace that declares a finance-domain sensitive policy and two projects.
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  fs.mkdirSync(path.join(root, '.ai-memory'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ai-memory', 'memory-policy.json'),
    JSON.stringify({ sensitivePatterns: ['\\bFO\\d{3,}\\b'] }),
  );
  fs.mkdirSync(path.join(root, 'agent', '_projects'), { recursive: true });
  for (const p of ['api-service', 'web-app']) fs.mkdirSync(path.join(root, 'agent', '_projects', p));
  return root;
}

test('drops noise session_summaries, keeps real ones + other types', () => {
  const root = fixtureRoot();
  const lines = [
    JSON.stringify({ id: 1, type: 'session_summary', title: 'You are extracting ACTIONABLE RULES for x' }),
    JSON.stringify({ id: 2, type: 'session_summary', title: 'log session abc12345 (Dev)' }),
    JSON.stringify({ id: 3, type: 'session_summary', title: 'Fix the SSE stream ordering bug in agents' }),
    JSON.stringify({ id: 4, type: 'bugfix', title: 'hi' }),          // non-summary always kept
    JSON.stringify({ id: 5, type: 'session_summary', title: 'Reconcile FO12345 cash balance' }),
  ].join('\n');
  const { kept, dropped, reasons } = pruneJsonl(lines, root);
  assert.equal(dropped.length, 3);
  assert.equal(kept.length, 2);                                       // #3 and #4
  assert.deepEqual(reasons, { 'prompt-leak': 1, 'log-session': 1, 'sensitive-data': 1 });
});

test('drops sensitive data on non-summary types + backfills project', () => {
  const root = fixtureRoot();
  const lines = [
    JSON.stringify({ id: 1, type: 'bugfix', title: 'wiped tax lots for FO54321', project: 'api-service' }),
    JSON.stringify({ id: 2, type: 'discovery', title: 'fix in web-app Utils.js' }), // no project -> backfill
    JSON.stringify({ id: 3, type: 'pattern', title: 'generic pattern', project: 'api-service' }),
  ].join('\n');
  const { kept, dropped, reasons, backfilled } = pruneJsonl(lines, root);
  assert.equal(dropped.length, 1);                 // the FO54321 bugfix
  assert.equal(reasons['sensitive-data'], 1);
  assert.equal(backfilled, 1);                      // #2 gets web-app
  assert.equal(kept.length, 2);
  assert.match(kept.find((l) => l.includes('"id":2')), /web-app/);
});

test('with no policy declared, domain data survives the prune', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-nopolicy-'));
  const lines = JSON.stringify({ id: 1, type: 'bugfix', title: 'wiped tax lots for FO54321' });
  const { kept, dropped } = pruneJsonl(lines, root);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
});

test('malformed lines are kept verbatim', () => {
  const { kept, dropped } = pruneJsonl('not json\n{bad}\n', fixtureRoot());
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
});
