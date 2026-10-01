'use strict';

// value-logger routes events to the REAL workspace root. It delegates root
// resolution to the shared _lib/workspace-root helper (covered by
// workspace-root.test.js) — this file pins the write-path contract: the log lands
// at <root>/.claude/logs/value-events.jsonl and never in a nested .claude dir.
// (Regression: value-logger used to keep its own CLAUDE.md-only resolver, so hooks
// wrote into scripts/hooks/.claude/logs/ and split telemetry off the dashboard.)

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { logValueEvent } = require('../../scripts/hooks/value-logger');

test('logValueEvent writes to <root>/.claude/logs/value-events.jsonl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlog-'));
  const prev = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  try {
    logValueEvent('rule_injection', 2, { categories: ['x'], ruleIds: ['a', 'b'] }, 's1');
    const logPath = path.join(root, '.claude', 'logs', 'value-events.jsonl');
    assert.ok(fs.existsSync(logPath), 'log written at the real root');
    const e = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(e.type, 'rule_injection');
    assert.equal(e.count, 2);
    assert.equal(e.sessionId, 's1');
    assert.deepEqual(e.details.ruleIds, ['a', 'b']);
    // The stray nested path must NOT be created.
    assert.ok(!fs.existsSync(path.join(root, 'scripts', 'hooks', '.claude')), 'no nested .claude created');
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = prev;
  }
});

test('logValueEvent fails silently on a bad root rather than throwing (hooks must never break)', () => {
  const prev = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = '/dev/null/cannot-write-here';
  try {
    assert.doesNotThrow(() => logValueEvent('rule_injection', 1, {}, 's'));
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = prev;
  }
});
