'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const ss = require('../../scripts/_lib/session-state');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')); }
function writeSidecar(root, id, obj) {
  const dir = ss.sidecarDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(obj));
}

test('readSidecar returns null for empty id / missing file / bad json', () => {
  const root = tmpRoot();
  assert.equal(ss.readSidecar(root, ''), null);
  assert.equal(ss.readSidecar(root, 'nope'), null);
  fs.mkdirSync(ss.sidecarDir(root), { recursive: true });
  fs.writeFileSync(path.join(ss.sidecarDir(root), 'bad.json'), 'not json');
  assert.equal(ss.readSidecar(root, 'bad'), null);
});

test('readSidecar round-trips a written sidecar', () => {
  const root = tmpRoot();
  writeSidecar(root, 's1', { project: 'api-service', jira_ticket: 'PROJ-1', files_touched: ['a.js'] });
  const s = ss.readSidecar(root, 's1');
  assert.equal(s.project, 'api-service');
});

test('typed accessors apply safe defaults', () => {
  assert.deepEqual(ss.filesTouched(null), []);
  assert.deepEqual(ss.filesTouched({ files_touched: 'nope' }), []);
  assert.deepEqual(ss.filesTouched({ files_touched: ['x'] }), ['x']);
  assert.equal(ss.activeWorktree(null), '');
  assert.equal(ss.jiraTicket({ jira_ticket: ' PROJ-9 ' }), 'PROJ-9');
  assert.equal(ss.project({}), '');
});

test('listSessionIds + readSessions skip non-json and unparseable', () => {
  const root = tmpRoot();
  writeSidecar(root, 'a', { project: 'p' });
  writeSidecar(root, 'b', { project: 'q' });
  fs.writeFileSync(path.join(ss.sidecarDir(root), 'notes.txt'), 'x');           // ignored
  fs.writeFileSync(path.join(ss.sidecarDir(root), 'c.json'), 'broken');         // unparseable
  assert.deepEqual(ss.listSessionIds(root).sort(), ['a', 'b', 'c']);            // c listed…
  assert.deepEqual(ss.readSessions(root).map((s) => s.id).sort(), ['a', 'b']);  // …but not readable
});

test('listSessionIds returns [] when the dir is absent', () => {
  assert.deepEqual(ss.listSessionIds(tmpRoot()), []);
});

test('updateSidecar mutates an existing sidecar atomically', async () => {
  const root = tmpRoot();
  writeSidecar(root, 's1', { project: 'p', files_touched: ['a'] });
  const next = await ss.updateSidecar(root, 's1', (s) => ({ ...s, verify_local: 'passed' }));
  assert.equal(next.verify_local, 'passed');
  assert.equal(ss.readSidecar(root, 's1').verify_local, 'passed');
  assert.equal(ss.readSidecar(root, 's1').project, 'p', 'existing fields preserved');
});

test('updateSidecar no-ops (creates nothing) when the sidecar is absent or id empty', async () => {
  const root = tmpRoot();
  assert.equal(await ss.updateSidecar(root, 'ghost', (s) => ({ ...s, x: 1 })), undefined);
  assert.equal(await ss.updateSidecar(root, '', (s) => s), undefined);
  assert.equal(ss.readSidecar(root, 'ghost'), null, 'no sidecar was fabricated');
});

test('readWorkflowState parses current.agent/phase, strips conversation- prefix', () => {
  const root = tmpRoot();
  const dir = ss.sidecarDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'uuid1.yaml'), 'current:\n  phase: 3\n  agent: "developer"\n');
  assert.deepEqual(ss.readWorkflowState(root, 'uuid1'), { agent: 'developer', phase: 3 });
  assert.deepEqual(ss.readWorkflowState(root, 'conversation-uuid1'), { agent: 'developer', phase: 3 });
  assert.equal(ss.readWorkflowState(root, 'missing'), null);
});
