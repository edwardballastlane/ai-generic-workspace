'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../scripts/_lib/memory-store');
const { exportChunk, importChunks, refreshManifest, signatureOf, exportDir } = require('../scripts/memory-export');

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'memexport-'));
  fs.writeFileSync(path.join(r, 'CLAUDE.md'), '# stub');
  return r;
}

test('export writes a plain-JSONL chunk (reviewable) + manifest', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'a', content: 'x', local: true }, { id: 'o1' });
  const r = exportChunk(root, 'alice');
  assert.equal(r.count, 1);
  const chunk = path.join(exportDir(root), 'alice.jsonl');
  assert.ok(fs.existsSync(chunk), 'plain .jsonl chunk exists');
  // Content is valid JSONL (diff-able), not gzipped bytes.
  const lines = fs.readFileSync(chunk, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).id, 'o1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(exportDir(root), 'manifest.json'), 'utf8')).chunks, ['alice.jsonl']);
});

test('export ships only local:true observations (no re-exporting imported/migrated)', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'mine', content: 'x', local: true }, { id: 'mine' });
  store.saveObservation(root, { title: 'theirs', content: 'y', local: false }, { id: 'theirs' });
  store.saveObservation(root, { title: 'migrated', content: 'z' }, { id: 'mig' }); // local defaults false
  const r = exportChunk(root, 'me');
  assert.equal(r.count, 1, 'only the local:true observation is exported');
  const ids = fs.readFileSync(path.join(exportDir(root), 'me.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, ['mine']);
});

test('export → import round-trips, marking imported obs local:false', () => {
  const src = tmpRoot();
  store.saveObservation(src, { title: 'design', content: 'freeze then forbid', type: 'decision', local: true }, { id: 'd1' });
  exportChunk(src, 'alice');

  const dst = tmpRoot();
  fs.mkdirSync(exportDir(dst), { recursive: true });
  for (const f of fs.readdirSync(exportDir(src))) fs.copyFileSync(path.join(exportDir(src), f), path.join(exportDir(dst), f));

  const res = importChunks(dst);
  assert.equal(res.added, 1);
  const imported = store.getObservation(dst, 'd1');
  assert.equal(imported.content, 'freeze then forbid');
  assert.equal(imported.local, false, 'imported obs is not re-exportable');
});

test('import is idempotent, and importing your OWN chunk back is a no-op', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'a', content: 'x', local: true }, { id: 'o1' });
  exportChunk(root, 'me');
  assert.equal(importChunks(root).added, 0, 'own local obs already present → 0');
  assert.equal(importChunks(root).added, 0, 're-import → 0');
});

test('signatureOf changes when a chunk changes (drives change-detected auto-import)', () => {
  const root = tmpRoot();
  store.saveObservation(root, { title: 'a', content: 'x', local: true }, { id: 'o1' });
  exportChunk(root, 'me');
  const sig1 = signatureOf(root);
  store.saveObservation(root, { title: 'b', content: 'y', local: true }, { id: 'o2' });
  exportChunk(root, 'me');
  assert.notEqual(sig1, signatureOf(root));
});

test('refreshManifest lists chunk files but not manifest.json itself', () => {
  const root = tmpRoot();
  fs.mkdirSync(exportDir(root), { recursive: true });
  fs.writeFileSync(path.join(exportDir(root), 'z.jsonl'), '');
  fs.writeFileSync(path.join(exportDir(root), 'a.jsonl'), '');
  assert.deepEqual(refreshManifest(root).chunks, ['a.jsonl', 'z.jsonl']);
});
