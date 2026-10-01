'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'backfill-jira-from-commits.js');

const USER_NAME = 'Backfill Tester';
const USER_EMAIL = 'backfill.tester@example.com';

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['config', 'user.email', USER_EMAIL], { cwd: dir });
  execFileSync('git', ['config', 'user.name', USER_NAME], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function commitWithDate(dir, isoDate, subject) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: USER_NAME,
    GIT_AUTHOR_EMAIL: USER_EMAIL,
    GIT_COMMITTER_NAME: USER_NAME,
    GIT_COMMITTER_EMAIL: USER_EMAIL,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', subject], { cwd: dir, env });
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

function run(env = {}, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// Build a workspace skeleton: <dir>/.ai-memory/session-end-events.jsonl
// committed under USER_EMAIL (so the email-mapping picks it up), and a single
// project repo at <dir>/projects/proj1 with the candidate commit(s).
function makeWorkspace({ projectsRoot, eventsFile, commits, eventTs }) {
  // Workspace events-file repo (for phase-1 mapping)
  const wsRoot = path.dirname(path.dirname(eventsFile));
  initRepo(wsRoot);
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  // Empty initial events file, then a commit so git log pairs are populated.
  fs.writeFileSync(eventsFile, '');
  execFileSync('git', ['add', '.ai-memory/session-end-events.jsonl'], { cwd: wsRoot });
  commitWithDate(wsRoot, eventTs, 'chore(events): seed events file');

  // Project repo with candidate commits
  fs.mkdirSync(projectsRoot, { recursive: true });
  const proj = path.join(projectsRoot, 'proj1');
  initRepo(proj);
  for (const c of commits) commitWithDate(proj, c.date, c.subject);
  return { wsRoot, proj };
}

// ── AC-16: audit picks up single-ticket window ─────────────────────────────

test('AC-16: audit reports back-fill candidate with single ticket in window', async () => {
  const dir = await tmpDir('bfj-audit-');
  try {
    const eventsFile = path.join(dir, 'ws', '.ai-memory', 'session-end-events.jsonl');
    const projectsRoot = path.join(dir, 'projects');
    const eventTs = '2026-04-01T12:00:00Z';
    makeWorkspace({
      projectsRoot,
      eventsFile,
      eventTs,
      commits: [
        { date: '2026-04-01T11:00:00Z', subject: 'PROJECT-1234 do thing' },
      ],
    });

    writeJsonl(eventsFile, [
      {
        type: 'session_end',
        session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
        ts: eventTs,
        user: USER_NAME,
        task: 'something unrelated',
        project: 'proj1',
      },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      PROJECTS_DIR_OVERRIDE: projectsRoot,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /back-fill candidate\s+1\b/);
    assert.match(r.stdout, /PROJECT-1234/);

    // Events file unchanged
    const after = readJsonl(eventsFile);
    assert.equal(after.length, 1);
    assert.equal(after[0].attribution_review_needed, undefined);
    assert.equal(after[0].primary_jira_ticket, undefined);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-17: apply annotates event, preserves jira_ticket ────────────────────

test('AC-17: apply writes annotations, creates .bak, preserves original jira_ticket', async () => {
  const dir = await tmpDir('bfj-apply-');
  try {
    const eventsFile = path.join(dir, 'ws', '.ai-memory', 'session-end-events.jsonl');
    const projectsRoot = path.join(dir, 'projects');
    const eventTs = '2026-04-01T12:00:00Z';
    makeWorkspace({
      projectsRoot,
      eventsFile,
      eventTs,
      commits: [
        { date: '2026-04-01T11:00:00Z', subject: 'PROJECT-1234 do thing' },
      ],
    });

    writeJsonl(eventsFile, [
      {
        type: 'session_end',
        session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
        ts: eventTs,
        user: USER_NAME,
        // jira_ticket is empty/null per AC criteria
        jira_ticket: '',
        project: 'proj1',
      },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      PROJECTS_DIR_OVERRIDE: projectsRoot,
    }, ['--apply']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);

    // .bak file present
    const backups = fs.readdirSync(path.dirname(eventsFile))
      .filter(n => n.startsWith('session-end-events.jsonl.bak.'));
    assert.equal(backups.length, 1, `expected one .bak file, got ${backups.join(',')}`);

    // Event annotated, original jira_ticket preserved
    const after = readJsonl(eventsFile);
    assert.equal(after.length, 1);
    assert.equal(after[0].attribution_review_needed, true);
    assert.equal(after[0].attribution_method, 'commit_window');
    assert.equal(after[0].primary_jira_ticket, 'PROJECT-1234');
    assert.equal(after[0].primary_project, 'proj1');
    assert.equal(after[0].jira_ticket, '', 'original jira_ticket must be preserved');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-18: tied plurality → AMBIGUOUS, no annotation ───────────────────────

test('AC-18: two tickets with equal counts classified ambiguous, no annotation', async () => {
  const dir = await tmpDir('bfj-ambig-');
  try {
    const eventsFile = path.join(dir, 'ws', '.ai-memory', 'session-end-events.jsonl');
    const projectsRoot = path.join(dir, 'projects');
    const eventTs = '2026-04-01T12:00:00Z';
    makeWorkspace({
      projectsRoot,
      eventsFile,
      eventTs,
      commits: [
        { date: '2026-04-01T11:00:00Z', subject: 'PROJECT-1111 first thing' },
        { date: '2026-04-01T11:30:00Z', subject: 'PROJECT-2222 second thing' },
      ],
    });

    writeJsonl(eventsFile, [
      {
        type: 'session_end',
        session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
        ts: eventTs,
        user: USER_NAME,
        project: 'proj1',
      },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      PROJECTS_DIR_OVERRIDE: projectsRoot,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /multi-ticket window\s+1\b/);
    assert.match(r.stdout, /back-fill candidate\s+0\b/);

    // --apply on the same setup must NOT annotate
    const r2 = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      PROJECTS_DIR_OVERRIDE: projectsRoot,
    }, ['--apply']);
    assert.equal(r2.status, 0, `exit ${r2.status}\nstderr=${r2.stderr}\nstdout=${r2.stdout}`);
    const after = readJsonl(eventsFile);
    assert.equal(after.length, 1);
    assert.equal(after[0].attribution_review_needed, undefined);
    assert.equal(after[0].primary_jira_ticket, undefined);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AC-19: WINDOW_HOURS=0 → no candidates ──────────────────────────────────

test('AC-19: WINDOW_HOURS=0 yields zero candidates and reports no-ticket window', async () => {
  const dir = await tmpDir('bfj-zerowin-');
  try {
    const eventsFile = path.join(dir, 'ws', '.ai-memory', 'session-end-events.jsonl');
    const projectsRoot = path.join(dir, 'projects');
    const eventTs = '2026-04-01T12:00:00Z';
    makeWorkspace({
      projectsRoot,
      eventsFile,
      eventTs,
      commits: [
        // Commit one hour before the event ts — within ±2h default but outside ±0h.
        { date: '2026-04-01T11:00:00Z', subject: 'PROJECT-1234 do thing' },
      ],
    });

    writeJsonl(eventsFile, [
      {
        type: 'session_end',
        session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
        ts: eventTs,
        user: USER_NAME,
        project: 'proj1',
      },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      PROJECTS_DIR_OVERRIDE: projectsRoot,
      WINDOW_HOURS: '0',
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /no-ticket window\s+1\b/);
    assert.match(r.stdout, /back-fill candidate\s+0\b/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── Bonus: existing real ticket → skipped, not rewritten ───────────────────

test('event with existing real jira_ticket is skipped (no qualification)', async () => {
  const dir = await tmpDir('bfj-existing-');
  try {
    const eventsFile = path.join(dir, 'ws', '.ai-memory', 'session-end-events.jsonl');
    const projectsRoot = path.join(dir, 'projects');
    const eventTs = '2026-04-01T12:00:00Z';
    makeWorkspace({
      projectsRoot,
      eventsFile,
      eventTs,
      commits: [
        { date: '2026-04-01T11:00:00Z', subject: 'PROJECT-1234 do thing' },
      ],
    });

    writeJsonl(eventsFile, [
      {
        type: 'session_end',
        session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
        ts: eventTs,
        user: USER_NAME,
        jira_ticket: 'PROJ-9999',
        project: 'proj1',
      },
    ]);

    const r = run({
      EVENTS_FILE_OVERRIDE: eventsFile,
      PROJECTS_DIR_OVERRIDE: projectsRoot,
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /back-fill candidate\s+0\b/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
