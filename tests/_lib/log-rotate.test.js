'use strict';

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { rotateIfTooLarge } = require('../../scripts/_lib/log-rotate')

test('does nothing when file is below threshold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-'))
  const log = path.join(dir, 'a.log')
  await fs.writeFile(log, 'small')
  await rotateIfTooLarge(log, 1024, 256)
  const got = await fs.readFile(log, 'utf8')
  assert.equal(got, 'small')
  await fs.rm(dir, { recursive: true, force: true })
})

test('does nothing when file is missing', async () => {
  await rotateIfTooLarge('/does/not/exist.log', 1024, 256)
  // no throw = pass
})

test('truncates to last keepBytes when over maxBytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-'))
  const log = path.join(dir, 'a.log')
  // 1000 bytes of '.' followed by 'TAIL_MARKER'
  await fs.writeFile(log, '.'.repeat(1000) + 'TAIL_MARKER')
  await rotateIfTooLarge(log, 500, 100)
  const got = await fs.readFile(log, 'utf8')
  assert.equal(got.length, 100)
  assert.ok(got.endsWith('TAIL_MARKER'), `expected tail marker, got: ${JSON.stringify(got.slice(-20))}`)
  await fs.rm(dir, { recursive: true, force: true })
})
