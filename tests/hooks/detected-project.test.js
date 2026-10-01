'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { read, write, cachePath } = require('../../scripts/hooks/_lib/detected-project');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'detected-project-'));
}

test('read returns the cached project when session_id matches', async () => {
  const root = await tmpRoot();
  try {
    write(root, 'sid-a', 'my-backend');
    assert.equal(read(root, 'sid-a'), 'my-backend');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('read returns empty when another session wrote the cache', async () => {
  const root = await tmpRoot();
  try {
    write(root, 'sid-b', 'my-portal-web');
    // Different session asking for its own cached project — must NOT see B's value.
    assert.equal(read(root, 'sid-a'), '');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('read returns empty for malformed legacy 1-line file', async () => {
  const root = await tmpRoot();
  try {
    fs.mkdirSync(path.join(root, '.ai-session'), { recursive: true });
    fs.writeFileSync(cachePath(root), 'my-portal-web\n');
    assert.equal(read(root, 'sid-a'), '');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('read returns empty when cache file is missing', async () => {
  const root = await tmpRoot();
  try {
    assert.equal(read(root, 'sid-a'), '');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('write is a no-op when sessionId or project is empty', async () => {
  const root = await tmpRoot();
  try {
    write(root, '', 'my-backend');
    write(root, 'sid-a', '');
    let exists = true;
    try { await fsp.access(cachePath(root)); } catch { exists = false; }
    assert.equal(exists, false, 'write must not create the file with empty inputs');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('write overwrites prior session_id (later session takes the cache)', async () => {
  const root = await tmpRoot();
  try {
    write(root, 'sid-a', 'my-backend');
    write(root, 'sid-b', 'my-portal-web');
    // sid-a no longer wins the cache.
    assert.equal(read(root, 'sid-a'), '');
    assert.equal(read(root, 'sid-b'), 'my-portal-web');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
