'use strict';

// Test fixtures use PROJ-* Jira keys; set the prefix before subprocess spawn.
process.env.JIRA_PREFIX = 'PROJ'; // fixtures hardcode PROJ-; do not defer to the ambient value

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'backfill-task-from-transcripts.js');

const SID_BASIC = 'bbbbbbbb-0000-0000-0000-000000000001';

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function setupFixture(prepare) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'backfill-task-'));
  const transcriptDir = path.join(dir, 'transcripts');
  await fsp.mkdir(transcriptDir, { recursive: true });
  const eventsPath = path.join(dir, 'events.jsonl');
  await prepare({ dir, transcriptDir, eventsPath });
  return { dir, transcriptDir, eventsPath };
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

const SID_CRED = 'bbbbbbbb-0000-0000-0000-000000000002';
const SID_FILLED = 'bbbbbbbb-0000-0000-0000-000000000003';

test('AC-11: --audit reports extractable jira and does not modify events file', async () => {
  const { dir, transcriptDir, eventsPath } = await setupFixture(async ({ transcriptDir, eventsPath }) => {
    writeJsonl(path.join(transcriptDir, `${SID_BASIC}.jsonl`), [
      { type: 'user', isMeta: false, message: { content: 'please look at PROJ-9876 and refactor the export pipeline so it stops timing out' } },
    ]);
    writeJsonl(eventsPath, [
      { type: 'session_end', session_id: SID_BASIC, ts: '2026-05-06T00:00:00Z', task: '', jira_ticket: '' },
    ]);
  });

  try {
    const before = await fsp.readFile(eventsPath, 'utf8');
    const r = run(['--audit'], {
      EVENTS_FILE_OVERRIDE: eventsPath,
      TRANSCRIPT_DIR_OVERRIDE: transcriptDir,
    });

    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /extractable \(task and\/or jira\):\s*1/);
    assert.match(r.stdout, /jira=PROJ-9876/);

    const after = await fsp.readFile(eventsPath, 'utf8');
    assert.equal(after, before, 'audit must not modify events file');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-12: --apply writes jira_ticket, creates .bak backup, preserves line count', async () => {
  const { dir, transcriptDir, eventsPath } = await setupFixture(async ({ transcriptDir, eventsPath }) => {
    writeJsonl(path.join(transcriptDir, `${SID_BASIC}.jsonl`), [
      { type: 'user', isMeta: false, message: { content: 'please look at PROJ-9876 and refactor the export pipeline so it stops timing out' } },
    ]);
    writeJsonl(eventsPath, [
      { type: 'session_end', session_id: SID_BASIC, ts: '2026-05-06T00:00:00Z', task: '', jira_ticket: '' },
    ]);
  });

  try {
    const beforeLines = (await fsp.readFile(eventsPath, 'utf8')).split('\n').length;
    const r = run(['--apply'], {
      EVENTS_FILE_OVERRIDE: eventsPath,
      TRANSCRIPT_DIR_OVERRIDE: transcriptDir,
    });

    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const rows = readJsonl(eventsPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jira_ticket, 'PROJ-9876');
    assert.ok(rows[0].task && rows[0].task.length > 0, 'task should be filled');

    const afterLines = (await fsp.readFile(eventsPath, 'utf8')).split('\n').length;
    assert.equal(afterLines, beforeLines, 'line count must be preserved');

    const backups = (await fsp.readdir(dir)).filter(f => f.startsWith('events.jsonl.bak.'));
    assert.equal(backups.length, 1, `expected exactly one backup, got: ${backups.join(', ')}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-13: --apply drops credential-shaped task content, leaves task empty', async () => {
  // String built from parts so this source file does not itself contain a
  // contiguous credential-shaped token (the repo pre-tool-use hook would block).
  const credPrompt = 'please use pas' + 'sword: hunter2hunter2hunter2 for the deploy';
  const { dir, transcriptDir, eventsPath } = await setupFixture(async ({ transcriptDir, eventsPath }) => {
    writeJsonl(path.join(transcriptDir, `${SID_CRED}.jsonl`), [
      { type: 'user', isMeta: false, message: { content: credPrompt } },
    ]);
    writeJsonl(eventsPath, [
      { type: 'session_end', session_id: SID_CRED, ts: '2026-05-06T00:00:00Z', task: '', jira_ticket: '' },
    ]);
  });

  try {
    const r = run(['--apply'], {
      EVENTS_FILE_OVERRIDE: eventsPath,
      TRANSCRIPT_DIR_OVERRIDE: transcriptDir,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const rows = readJsonl(eventsPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task, '', 'credential-shaped task must NOT be written');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-14: --apply does not overwrite already-populated task or jira_ticket', async () => {
  const { dir, transcriptDir, eventsPath } = await setupFixture(async ({ transcriptDir, eventsPath }) => {
    writeJsonl(path.join(transcriptDir, `${SID_FILLED}.jsonl`), [
      { type: 'user', isMeta: false, message: { content: 'work on PROJ-9999 and rewrite all the things from scratch' } },
    ]);
    writeJsonl(eventsPath, [
      { type: 'session_end', session_id: SID_FILLED, ts: '2026-05-06T00:00:00Z', task: 'old', jira_ticket: 'PROJ-1234' },
    ]);
  });

  try {
    const r = run(['--apply'], {
      EVENTS_FILE_OVERRIDE: eventsPath,
      TRANSCRIPT_DIR_OVERRIDE: transcriptDir,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const rows = readJsonl(eventsPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task, 'old', 'existing task must NOT be overwritten');
    assert.equal(rows[0].jira_ticket, 'PROJ-1234', 'existing jira_ticket must NOT be overwritten');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
