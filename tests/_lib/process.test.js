'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicWrite, withFileLock, atomicUpdateJson, spawnDetached } = require('../../scripts/_lib/process');

test('atomicWrite creates the file with given contents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-'));
  const target = path.join(dir, 'out.txt');
  await atomicWrite(target, 'hello');
  const got = await fs.readFile(target, 'utf8');
  assert.equal(got, 'hello');
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomicWrite leaves no temp file behind on success', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-'));
  const target = path.join(dir, 'out.txt');
  await atomicWrite(target, 'hello');
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['out.txt']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('withFileLock serializes overlapping critical sections (no lost update)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'));
  const target = path.join(dir, 'counter.json');
  await fs.writeFile(target, JSON.stringify({ count: 0 }));

  // Fire 20 concurrent read-increment-write cycles WITHOUT any locking, each
  // reading the file directly — this is the exact shape of the bug in
  // recordFileTouched before the fix. If withFileLock actually serializes
  // them, the final count must be exactly 20; a lost-update race would leave
  // it lower.
  await Promise.all(Array.from({ length: 20 }, () =>
    withFileLock(target, async () => {
      const current = JSON.parse(await fs.readFile(target, 'utf8'));
      // Yield so overlapping calls interleave instead of running lock-step —
      // without the lock this reliably reproduces the lost update.
      await new Promise((resolve) => setTimeout(resolve, 5));
      current.count += 1;
      await atomicWrite(target, JSON.stringify(current));
    })
  ));

  const final = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(final.count, 20);
  await fs.rm(dir, { recursive: true, force: true });
});

test('withFileLock breaks a stale lock left behind by a crashed holder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'));
  const target = path.join(dir, 'out.json');
  await fs.writeFile(target, JSON.stringify({ n: 0 }));
  // Simulate an abandoned lock (holder crashed without releasing it).
  await fs.writeFile(`${target}.lock`, '');
  const oldTime = new Date(Date.now() - 10_000);
  await fs.utimes(`${target}.lock`, oldTime, oldTime);

  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify({ n: 1 }));
  }, { staleMs: 1000, timeoutMs: 2000 });

  const final = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(final.n, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomicUpdateJson defaults to {} for a missing file and writes the mutated result', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'));
  const target = path.join(dir, 'sidecar.json');

  const result = await atomicUpdateJson(target, (current) => ({ ...current, files_touched: ['a.js'] }));
  assert.deepEqual(result, { files_touched: ['a.js'] });

  const onDisk = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(onDisk, { files_touched: ['a.js'] });
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomicUpdateJson skips the write when mutate returns undefined', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'));
  const target = path.join(dir, 'sidecar.json');
  await fs.writeFile(target, JSON.stringify({ files_touched: ['a.js'] }));
  const before = (await fs.stat(target)).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await atomicUpdateJson(target, (current) =>
    current.files_touched.includes('a.js') ? undefined : { ...current, files_touched: [...current.files_touched, 'a.js'] }
  );

  assert.equal(result, undefined);
  const after = (await fs.stat(target)).mtimeMs;
  assert.equal(after, before, 'file must not be rewritten when mutate opts out');
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomicUpdateJson concurrent appends: every distinct value survives', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'));
  const target = path.join(dir, 'sidecar.json');
  await fs.writeFile(target, JSON.stringify({ files_touched: [] }));

  const files = Array.from({ length: 10 }, (_, i) => `file-${i}.js`);
  await Promise.all(files.map((f) =>
    atomicUpdateJson(target, (current) => {
      const filesTouched = Array.isArray(current.files_touched) ? current.files_touched : [];
      if (filesTouched.includes(f)) return undefined;
      return { ...current, files_touched: [...filesTouched, f] };
    })
  ));

  const final = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual([...final.files_touched].sort(), [...files].sort());
  await fs.rm(dir, { recursive: true, force: true });
});

test('spawnDetached returns immediately and child outlives parent ref', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-'));
  const marker = path.join(dir, 'marker.txt');
  // node -e: write marker, exit. Use JSON.stringify to escape Windows backslashes.
  const child = spawnDetached(process.execPath, [
    '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`
  ]);
  assert.equal(child.unrefCalled, true);
  // poll up to 2s for the marker to appear
  for (let i = 0; i < 20; i++) {
    try {
      const got = await fs.readFile(marker, 'utf8');
      assert.equal(got, 'ok');
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('detached child did not write marker within 2s');
});
