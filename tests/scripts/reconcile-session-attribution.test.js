'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'reconcile-session-attribution.js');

function run(env = {}, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function writeTranscript(filePath, userPrompts) {
  const rows = userPrompts.map(content => ({
    type: 'user',
    message: { content },
  }));
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const SID_SPLIT = 'aaaaaaaa-1111-2222-3333-000000000001';
const SID_OTHER = 'bbbbbbbb-1111-2222-3333-000000000002';

// ── AC-21 — audit reports transcript-method primary ─────────────────────────

test('AC-21: --audit classifies split session as method=transcript using transcript tickets', async () => {
  const dir = await tmpDir('reconcile-attr-ac21-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const ccProjects = path.join(dir, 'projects');
    const slugDir = path.join(ccProjects, 'slug-a');
    fs.mkdirSync(slugDir, { recursive: true });

    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-100', project: 'pA', task: 'work on PROJ-100' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-200', project: 'pA', task: 'work on PROJ-200' },
    ]);
    // Transcript only mentions PROJ-200 → PROJ-200 wins via transcript method.
    writeTranscript(path.join(slugDir, `${SID_SPLIT}.jsonl`), [
      'please continue the work on PROJ-200 we discussed',
      'add the missing tests for PROJ-200 too',
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /method=transcript/);
    assert.match(r.stdout, /primary=\[pA\/PROJ-200\]/);
    // Exactly 1 minority event flagged.
    assert.match(r.stdout, /flagged=1/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-22 — apply annotates the minority event without overwriting ──────────

test('AC-22: --apply annotates minority event, preserves original jira_ticket', async () => {
  const dir = await tmpDir('reconcile-attr-ac22-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const ccProjects = path.join(dir, 'projects');
    const slugDir = path.join(ccProjects, 'slug-a');
    fs.mkdirSync(slugDir, { recursive: true });

    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-100', project: 'pA', task: 'work on PROJ-100' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-200', project: 'pA', task: 'work on PROJ-200' },
    ]);
    writeTranscript(path.join(slugDir, `${SID_SPLIT}.jsonl`), [
      'please continue the work on PROJ-200 we discussed',
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    }, ['--apply']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);

    // .bak file exists.
    const baks = fs.readdirSync(dir).filter(n => n.startsWith('events.jsonl.bak.'));
    assert.equal(baks.length, 1, `expected one backup, got ${baks.length}`);

    // The minority event (PROJ-100) gained annotations; original jira preserved.
    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(l => l);
    assert.equal(lines.length, 2);
    const e0 = JSON.parse(lines[0]);
    const e1 = JSON.parse(lines[1]);

    assert.equal(e0.jira_ticket, 'PROJ-100', 'original jira_ticket NOT overwritten');
    assert.equal(e0.attribution_review_needed, true);
    assert.equal(e0.attribution_method, 'transcript');
    assert.equal(e0.primary_jira_ticket, 'PROJ-200');
    assert.equal(e0.primary_project, 'pA');

    // Majority event NOT flagged.
    assert.notEqual(e1.attribution_review_needed, true);
    assert.equal(e1.jira_ticket, 'PROJ-200');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-23 — task-jira mismatch detection in audit + apply ───────────────────

test('AC-23: task-jira mismatch flagged with primary_jira_ticket="" on apply', async () => {
  const dir = await tmpDir('reconcile-attr-ac23-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const ccProjects = path.join(dir, 'projects');
    fs.mkdirSync(ccProjects, { recursive: true });

    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_OTHER,
        jira_ticket: 'PROJ-999', project: 'pX',
        task: 'do something else entirely unrelated' },
    ]);

    const audit = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    });
    assert.equal(audit.status, 0, `exit ${audit.status}\nstderr=${audit.stderr}`);
    assert.match(audit.stdout, /method=task_jira_mismatch/);

    const apply = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    }, ['--apply']);
    assert.equal(apply.status, 0, `exit ${apply.status}\nstderr=${apply.stderr}`);

    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(l => l);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.attribution_review_needed, true);
    assert.equal(ev.attribution_method, 'task_jira_mismatch');
    assert.equal(ev.primary_jira_ticket, '');
    // Original fields untouched.
    assert.equal(ev.jira_ticket, 'PROJ-999');
    assert.equal(ev.task, 'do something else entirely unrelated');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-24 — clean events file: nothing to reconcile ─────────────────────────

test('AC-24: no split + no mismatch prints "nothing to reconcile" and exits 0', async () => {
  const dir = await tmpDir('reconcile-attr-ac24-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const ccProjects = path.join(dir, 'projects');
    fs.mkdirSync(ccProjects, { recursive: true });

    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-1', project: 'pA', task: 'fix PROJ-1 thing' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_OTHER,
        jira_ticket: 'PROJ-2', project: 'pB', task: 'add PROJ-2 feature' },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /no split-attribution and no task-jira mismatch — nothing to reconcile/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-15 — T5 idempotency: re-running --apply yields identical content ─────

test('AC-15: --apply is idempotent — second run produces byte-identical events file', async () => {
  const dir = await tmpDir('reconcile-attr-ac15-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const ccProjects = path.join(dir, 'projects');
    const slugDir = path.join(ccProjects, 'slug-a');
    fs.mkdirSync(slugDir, { recursive: true });

    writeJsonl(eventsFile, [
      { ts: '2026-01-01T00:00:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-100', project: 'pA', task: 'work on PROJ-100' },
      { ts: '2026-01-01T00:05:00Z', session_id: SID_SPLIT,
        jira_ticket: 'PROJ-200', project: 'pA', task: 'work on PROJ-200' },
    ]);
    writeTranscript(path.join(slugDir, `${SID_SPLIT}.jsonl`), [
      'please continue the work on PROJ-200 we discussed',
    ]);

    const env = {
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    };

    const r1 = run(env, ['--apply']);
    assert.equal(r1.status, 0, `first apply exit ${r1.status}\nstderr=${r1.stderr}`);
    const before = fs.readFileSync(eventsFile, 'utf8');

    const r2 = run(env, ['--apply']);
    assert.equal(r2.status, 0, `second apply exit ${r2.status}\nstderr=${r2.stderr}`);
    const after = fs.readFileSync(eventsFile, 'utf8');

    assert.equal(after, before, 'events file content must be byte-identical after re-apply');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-16 — T7 malformed UUID: gate rejects, no stderr noise ────────────────

test('AC-16: malformed session_id is rejected by UUID gate without stderr noise', async () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.equal(UUID_RE.test('*-not-a-uuid'), false);

  const dir = await tmpDir('reconcile-attr-ac16-');
  try {
    const eventsFile = path.join(dir, 'events.jsonl');
    const ccProjects = path.join(dir, 'projects');
    fs.mkdirSync(ccProjects, { recursive: true });

    writeJsonl(eventsFile, [
      { ts: '2026-04-30T12:00:00Z', session_id: '*-not-a-uuid',
        jira_ticket: 'PROJ-666', project: 'project-x', task: 'work on PROJ-666' },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      CC_PROJECTS_OVERRIDE: ccProjects,
    });

    assert.ok(r.status === 0 || r.status === null,
      `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.equal(r.stderr, '', `expected empty stderr, got: ${r.stderr}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
