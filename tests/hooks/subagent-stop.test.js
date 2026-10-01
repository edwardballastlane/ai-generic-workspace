'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'subagent-stop.js');

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sas-'));
  // Drop a CLAUDE.md sentinel so findWorkspaceRoot anchors here, not the
  // real workspace; otherwise tests would clobber the actual log file.
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# test root\n');
  return root;
}

function runHook(root, hookInput) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: typeof hookInput === 'string' ? hookInput : JSON.stringify(hookInput),
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_ROOT: root },
  });
}

test('AC-14: appends subagent_stop event with all required keys + 200-char preview', async () => {
  const root = await setupRoot();
  try {
    const longMessage = 'A'.repeat(500);
    const r = runHook(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      agent_id: 'agent-abc',
      agent_type: 'researcher',
      permission_mode: 'default',
      agent_transcript_path: '/tmp/fake-transcript.jsonl',
      last_assistant_message: longMessage,
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);

    const eventsPath = path.join(root, '.claude', 'logs', 'subagent-events.jsonl');
    const raw = await fs.readFile(eventsPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);

    assert.equal(ev.type, 'subagent_stop');
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(ev.session_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(ev.agent_id, 'agent-abc');
    assert.equal(ev.agent_type, 'researcher');
    assert.equal(ev.permission_mode, 'default');
    assert.equal(ev.transcript_path, '/tmp/fake-transcript.jsonl');
    assert.equal(ev.last_message_preview.length, 200);
    assert.equal(ev.last_message_preview, 'A'.repeat(200));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-15: empty stdin → no append, exit 0', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, '');
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);

    const eventsPath = path.join(root, '.claude', 'logs', 'subagent-events.jsonl');
    let exists = true;
    try { await fs.access(eventsPath); } catch { exists = false; }
    assert.equal(exists, false, 'expected no events file when stdin is empty');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('creates .claude/logs directory if missing', async () => {
  const root = await setupRoot();
  try {
    // Ensure parent dir does not pre-exist.
    let preExists = true;
    try { await fs.access(path.join(root, '.claude')); } catch { preExists = false; }
    assert.equal(preExists, false);

    const r = runHook(root, {
      session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      agent_id: 'a1',
      agent_type: 'impl',
      permission_mode: 'plan',
      agent_transcript_path: '',
      last_assistant_message: 'short',
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);

    const eventsPath = path.join(root, '.claude', 'logs', 'subagent-events.jsonl');
    const raw = await fs.readFile(eventsPath, 'utf8');
    const ev = JSON.parse(raw.trim());
    assert.equal(ev.session_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(ev.last_message_preview, 'short');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('malformed JSON → exit 0, no append', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, '{not json');
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);

    const eventsPath = path.join(root, '.claude', 'logs', 'subagent-events.jsonl');
    let exists = true;
    try { await fs.access(eventsPath); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing optional fields default to empty string / "unknown"', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, { session_id: 'x' });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);

    const eventsPath = path.join(root, '.claude', 'logs', 'subagent-events.jsonl');
    const ev = JSON.parse((await fs.readFile(eventsPath, 'utf8')).trim());
    assert.equal(ev.session_id, 'x');
    assert.equal(ev.agent_id, '');
    assert.equal(ev.agent_type, 'unknown');
    assert.equal(ev.permission_mode, '');
    assert.equal(ev.transcript_path, '');
    assert.equal(ev.last_message_preview, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
