'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectModel } = require('../scripts/agent-router');

const CLI = path.join(__dirname, '..', 'scripts', 'agent-router.js');

test('low complexity routes to haiku', () => {
  assert.equal(selectModel({ agentType: 'implementer', complexity: 'low', fileCount: 1 }), 'haiku');
});

test('trivial description routes to haiku even at medium complexity', () => {
  assert.equal(selectModel({ agentType: 'implementer', complexity: 'medium', description: 'fix a typo in the README' }), 'haiku');
});

test('high complexity routes to opus', () => {
  assert.equal(selectModel({ agentType: 'implementer', complexity: 'high', fileCount: 1 }), 'opus');
});

test('broad blast radius (>3 files) routes to opus', () => {
  assert.equal(selectModel({ agentType: 'implementer', complexity: 'medium', fileCount: 5 }), 'opus');
});

test('sensitive description routes to opus regardless of complexity', () => {
  assert.equal(selectModel({ agentType: 'implementer', complexity: 'low', description: 'update auth token validation' }), 'opus');
});

test('read-only/bounded agent roles route to sonnet', () => {
  assert.equal(selectModel({ agentType: 'reviewer', complexity: 'medium' }), 'sonnet');
  assert.equal(selectModel({ agentType: 'verifier', complexity: 'medium' }), 'sonnet');
  assert.equal(selectModel({ agentType: 'tester', complexity: 'medium' }), 'sonnet');
});

test('medium implementer work falls back to default (sonnet)', () => {
  assert.equal(selectModel({ agentType: 'implementer', complexity: 'medium', fileCount: 2 }), 'sonnet');
});

test('AGENT_ROUTER_DEFAULT overrides the fallback tier', () => {
  const prev = process.env.AGENT_ROUTER_DEFAULT;
  process.env.AGENT_ROUTER_DEFAULT = 'opus';
  try {
    assert.equal(selectModel({ agentType: 'implementer', complexity: 'medium', fileCount: 1 }), 'opus');
  } finally {
    if (prev === undefined) delete process.env.AGENT_ROUTER_DEFAULT;
    else process.env.AGENT_ROUTER_DEFAULT = prev;
  }
});

test('empty input falls back to sonnet', () => {
  assert.equal(selectModel({}), 'sonnet');
});

test('CLI prints the selected model', () => {
  const res = spawnSync(process.execPath, [CLI, '--agent', 'implementer', '--complexity', 'low', '--files', '1', '--desc', 'fix typo'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), 'haiku');
});
