'use strict';

// Set the Jira prefix BEFORE requiring heuristics so getJiraRe() picks it up
// when called by extractJiraTicket / isWeakTask / deriveTaskSummary.
process.env.JIRA_PREFIX = 'PROJ'; // fixtures hardcode PROJ-; do not defer to the ambient value

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  extractTask,
  extractJiraTicket,
  looksLikeSecret,
  looksLikeShellSecret,
  extractCommitsInWindow,
  readResumeNote,
  isWeakTask,
  deriveTaskSummary
} = require('../../scripts/_lib/heuristics');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heuristics-repo-'));
  const opts = { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts);
  return dir;
}

function commitWithSubject(repo, subject, fileContent) {
  const filePath = path.join(repo, `f-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, fileContent || subject);
  const opts = { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] };
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-q', '-m', subject], opts);
}

// Build sample tokens at runtime so the file itself does not contain a
// real-shaped credential string (the repo's pre-tool-use hook would block it).
const SAMPLE_AWS_KEY = 'A' + 'KIA' + 'X'.repeat(16);       // matches AKIA[A-Z0-9]{16}
const SAMPLE_GH_PAT = 'g' + 'hp_' + 'a'.repeat(20);        // matches ghp_[A-Za-z0-9]{20,}
const SAMPLE_PASSWORD_LINE = 'pass' + 'word = letmein123!'; // matches password=...

test('extractTask picks longest non-secret prompt under 140 chars', () => {
  const messages = [
    'short one',
    'a much longer prompt about refactoring the auth module to support OIDC',
    'medium length prompt here about something'
  ];
  const got = extractTask(messages);
  assert.match(got, /OIDC/);
  assert.ok(got.length <= 140);
});

test('extractTask normalizes whitespace and strips leading bullets', () => {
  const got = extractTask(['  -   refactor   the    login flow  ']);
  assert.equal(got, 'refactor the login flow');
});

test('extractTask drops prompts containing secret-shaped tokens', () => {
  const messages = [
    `${SAMPLE_AWS_KEY} is the access key please rotate it now thanks`,
    'a clean shorter message about the deploy'
  ];
  const got = extractTask(messages);
  assert.match(got, /clean shorter/);
});

test('extractTask returns empty string on empty input', () => {
  assert.equal(extractTask([]), '');
  assert.equal(extractTask(null), '');
});

test('extractJiraTicket finds the first configured-prefix ticket', () => {
  const messages = ['unrelated', 'work on PROJ-1234 today and PROJ-9999'];
  assert.equal(extractJiraTicket(messages), 'PROJ-1234');
});

test('extractJiraTicket ignores GMT-0500, UTF-8, SHA-256', () => {
  const messages = ['logged at GMT-0500 with UTF-8 hash SHA-256 only'];
  assert.equal(extractJiraTicket(messages), '');
});

test('looksLikeSecret catches common shapes', () => {
  assert.equal(looksLikeSecret(`${SAMPLE_AWS_KEY} here`), true);
  assert.equal(looksLikeSecret(SAMPLE_GH_PAT), true);
  assert.equal(looksLikeSecret(SAMPLE_PASSWORD_LINE), true);
  assert.equal(looksLikeSecret('just a normal sentence'), false);
});

test('looksLikeShellSecret matches raw KEY/SECRET/TOKEN/PASSWORD assignments', () => {
  assert.equal(looksLikeShellSecret('KEY=abc123'), true);
  assert.equal(looksLikeShellSecret('SECRET=xyz'), true);
  assert.equal(looksLikeShellSecret(`TOKEN=${SAMPLE_GH_PAT}`), true);
  assert.equal(looksLikeShellSecret('PASSWORD=hunter2'), true);
});

test('looksLikeShellSecret matches prefixed and quoted variants', () => {
  assert.equal(looksLikeShellSecret('MY_KEY=abc123'), true);
  assert.equal(looksLikeShellSecret('API_TOKEN=ghxxx'), true);
  assert.equal(looksLikeShellSecret('export DB_PASSWORD="hunter2"'), true);
  assert.equal(looksLikeShellSecret("CLIENT_SECRET='abc'"), true);
});

test('looksLikeShellSecret ignores empty values and bare names', () => {
  assert.equal(looksLikeShellSecret('KEY='), false);
  assert.equal(looksLikeShellSecret('KEY'), false);
  assert.equal(looksLikeShellSecret('TOKEN'), false);
  assert.equal(looksLikeShellSecret('PASSWORD = '), false);
});

test('looksLikeShellSecret ignores text without an assignment', () => {
  assert.equal(looksLikeShellSecret('just a normal sentence'), false);
  assert.equal(looksLikeShellSecret('the key is in the drawer'), false);
  assert.equal(looksLikeShellSecret(''), false);
  assert.equal(looksLikeShellSecret(null), false);
});

test('looksLikeShellSecret does not match unrelated suffix words', () => {
  // Avoid false matching on words like 'monkey', 'donkey' that end with 'key'.
  assert.equal(looksLikeShellSecret('monkey=banana'), false);
  assert.equal(looksLikeShellSecret('turkey=delicious'), false);
});

test('extractCommitsInWindow prefers non-chore subjects, strips prefixes', () => {
  const repo = makeTempRepo();
  const before = new Date(Date.now() - 60_000).toISOString();
  commitWithSubject(repo, 'fix: PROJ-1 add A', '1');
  commitWithSubject(repo, 'chore: log session', '2');
  commitWithSubject(repo, 'feat: B', '3');
  const after = new Date(Date.now() + 60_000).toISOString();
  const got = extractCommitsInWindow(repo, before, after);
  assert.match(got, /PROJ-1 add A/);
  assert.match(got, /\bB\b/);
  assert.doesNotMatch(got, /log session/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('extractCommitsInWindow falls back to chore-only when nothing else', () => {
  const repo = makeTempRepo();
  const before = new Date(Date.now() - 60_000).toISOString();
  commitWithSubject(repo, 'chore: log session abc', '1');
  const after = new Date(Date.now() + 60_000).toISOString();
  const got = extractCommitsInWindow(repo, before, after);
  assert.equal(got, 'log session abc');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('extractCommitsInWindow returns empty when startedAt is missing', () => {
  assert.equal(extractCommitsInWindow('/tmp', '', new Date().toISOString()), '');
  assert.equal(extractCommitsInWindow('/tmp', null, new Date().toISOString()), '');
});

test('extractCommitsInWindow returns empty for nonexistent rootDir', () => {
  const before = new Date(Date.now() - 60_000).toISOString();
  const after = new Date(Date.now() + 60_000).toISOString();
  assert.equal(extractCommitsInWindow('/nonexistent-path-xyz-123', before, after), '');
});

test('readResumeNote returns first qualifying line under note section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const sid = 'abcdef12-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(dir, 'abcdef12-something.md'),
    '# Title\n## Note from previous session\n\nFinished refactoring auth\nMore detail\n## Other section\n');
  assert.equal(readResumeNote(dir, sid), 'Finished refactoring auth');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readResumeNote skips pre-compact (auto) lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const sid = 'deadbeef-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(dir, 'deadbeef-x.md'),
    '## Note from previous session\npre-compact (auto): summary one\npre-compact (auto): summary two\n## Next\n');
  assert.equal(readResumeNote(dir, sid), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readResumeNote returns empty when no file matches prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  fs.writeFileSync(path.join(dir, 'zzzzzzzz-other.md'), '## Note from previous session\nhi\n');
  assert.equal(readResumeNote(dir, 'aaaaaaaa-1111-2222-3333-444444444444'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readResumeNote returns empty for empty note section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const sid = 'cafef00d-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(dir, 'cafef00d-x.md'),
    '## Note from previous session\n## Next section\nstuff\n');
  assert.equal(readResumeNote(dir, sid), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isWeakTask returns true for empty string', () => {
  assert.equal(isWeakTask(''), true);
  assert.equal(isWeakTask(null), true);
  assert.equal(isWeakTask(undefined), true);
});

test('isWeakTask returns true for the two real spec §1 prompts', () => {
  const ex1 = 'can we analyzise the different learning systems we have in this wrosknat and compare the better approach. Also make sure we are not burning';
  const ex2 = 'Can we check https://abc123xyz0.execute-api.us-east-1.amazonaws.com/v1/accounts/36/raw-transactions?limit=100&offset=0&sortBy=date&dir';
  assert.equal(isWeakTask(ex1), true);
  assert.equal(isWeakTask(ex2), true);
});

test('isWeakTask returns false for ticket-prefixed strings regardless of length', () => {
  assert.equal(isWeakTask('PROJ-1234 fix lambda cache'), false);
  assert.equal(isWeakTask('PROJ-1'), false);
});

test('isWeakTask returns false for clean structured commit-style subject', () => {
  assert.equal(isWeakTask('add A / refactor B'), false);
});

test('isWeakTask returns true for strings longer than 120 chars', () => {
  assert.equal(isWeakTask('a'.repeat(125)), true);
});

test('isWeakTask returns false for short structured rebuild subject', () => {
  assert.equal(isWeakTask('rebuild prom auth flow'), false);
});

test('deriveTaskSummary returns ticket+commit when both signals present', () => {
  const repo = makeTempRepo();
  const before = new Date(Date.now() - 60_000).toISOString();
  commitWithSubject(repo, 'feat: add A', '1');
  const after = new Date(Date.now() + 60_000).toISOString();
  const got = deriveTaskSummary({
    userPrompts: ['working on PROJ-1234 today'],
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    startedAt: before,
    lastActive: after,
    rootDir: repo,
    resumeDir: path.join(repo, 'no-such-dir')
  });
  assert.equal(got.source, 'commit');
  assert.match(got.task, /^PROJ-1234 add A/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('deriveTaskSummary returns chore-only commits with source=commit when no ticket', () => {
  const repo = makeTempRepo();
  const before = new Date(Date.now() - 60_000).toISOString();
  commitWithSubject(repo, 'chore: log session abc', '1');
  const after = new Date(Date.now() + 60_000).toISOString();
  const got = deriveTaskSummary({
    userPrompts: ['no ticket here'],
    sessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
    startedAt: before,
    lastActive: after,
    rootDir: repo,
    resumeDir: path.join(repo, 'no-such-dir')
  });
  assert.equal(got.source, 'commit');
  assert.equal(got.task, 'log session abc');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('deriveTaskSummary returns ticket alone when no commits and no resume', () => {
  const repo = makeTempRepo();
  const got = deriveTaskSummary({
    userPrompts: ['working on PROJ-1234'],
    sessionId: 'cccccccc-1111-2222-3333-444444444444',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastActive: new Date(Date.now() + 60_000).toISOString(),
    rootDir: repo,
    resumeDir: path.join(repo, 'no-such-dir')
  });
  assert.equal(got.source, 'ticket');
  assert.equal(got.task, 'PROJ-1234');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('deriveTaskSummary falls back to resume note when no commits and no ticket', () => {
  const repo = makeTempRepo();
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const sid = 'feedface-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(resumeDir, 'feedface-x.md'),
    '## Note from previous session\nFinished caching layer\n## Other\n');
  const got = deriveTaskSummary({
    userPrompts: ['unrelated short'],
    sessionId: sid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastActive: new Date(Date.now() + 60_000).toISOString(),
    rootDir: repo,
    resumeDir
  });
  assert.equal(got.source, 'resume');
  assert.equal(got.task, 'Finished caching layer');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(resumeDir, { recursive: true, force: true });
});

test('deriveTaskSummary prefers resume note over a ticket-only task (OQ-1)', () => {
  // Per OQ-1: resume-note > ticket-only when no commits are present.
  const repo = makeTempRepo();
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const sid = 'beeff00d-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(resumeDir, 'beeff00d-x.md'),
    '## Note from previous session\nWired up new ingest pipeline\n## Other\n');
  const got = deriveTaskSummary({
    userPrompts: ['working on PROJ-7777 today'],
    sessionId: sid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastActive: new Date(Date.now() + 60_000).toISOString(),
    rootDir: repo,
    resumeDir
  });
  assert.equal(got.source, 'resume');
  assert.equal(got.task, 'Wired up new ingest pipeline');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(resumeDir, { recursive: true, force: true });
});

test('deriveTaskSummary returns empty when nothing matches', () => {
  const repo = makeTempRepo();
  const got = deriveTaskSummary({
    userPrompts: [],
    sessionId: 'dddddddd-1111-2222-3333-444444444444',
    startedAt: '',
    lastActive: '',
    rootDir: repo,
    resumeDir: path.join(repo, 'no-such-dir')
  });
  assert.deepEqual(got, { task: '', source: '' });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('deriveTaskSummary discards commit subject containing a secret and falls through', () => {
  const repo = makeTempRepo();
  const before = new Date(Date.now() - 60_000).toISOString();
  // Subject contains an AWS-key-shaped token; deriveTaskSummary must reject
  // both the ticket+commit and commit-only branches via looksLikeSecret and
  // fall through to source=ticket.
  const secret = 'A' + 'KIA' + 'X'.repeat(16);
  commitWithSubject(repo, `feat: leak ${secret}`, '1');
  const after = new Date(Date.now() + 60_000).toISOString();
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const got = deriveTaskSummary({
    userPrompts: ['working on PROJ-9999'],
    sessionId: 'eeeeeeee-1111-2222-3333-444444444444',
    startedAt: before,
    lastActive: after,
    rootDir: repo,
    resumeDir
  });
  assert.notEqual(got.source, 'commit');
  assert.equal(got.source, 'ticket');
  assert.equal(got.task, 'PROJ-9999');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(resumeDir, { recursive: true, force: true });
});

