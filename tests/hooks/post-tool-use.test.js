'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'post-tool-use.js');

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ptu-'));
  // Ensure the workspace-root walker stops here even though no parent has CLAUDE.md.
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '');
  return root;
}

// PostToolUse hooks receive their payload via stdin JSON ({ session_id, tool_name,
// tool_input, ... }) — the same transport pre-tool-use.js uses, confirmed by tracing
// settings.json's identical "node ./scripts/hooks/*.js" registration for both hooks.
function runHook(root, payload) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, WORKSPACE_ROOT: root }
  });
}

// Non-blocking counterpart to runHook — needed to fire several hook
// invocations genuinely concurrently (spawnSync would run them one at a time,
// which can never reproduce a race between overlapping processes).
function runHookAsync(root, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: root,
      env: { ...process.env, WORKSPACE_ROOT: root }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function todayLog(root) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(root, '.ai-memory', 'audit', `${day}.log`);
}

async function writeSidecar(root, sessionId, data) {
  const dir = path.join(root, '.ai-session', 'by-id');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(data, null, 2));
}

async function readSidecar(root, sessionId) {
  const raw = await fs.readFile(path.join(root, '.ai-session', 'by-id', `${sessionId}.json`), 'utf8');
  return JSON.parse(raw);
}

test('AC-10: Write with file_path → log line written', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/foo.ts', content: 'x' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const contents = await fs.readFile(todayLog(root), 'utf8');
    assert.match(contents, /Write: src\/foo\.ts/);
    assert.match(contents, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-10: Edit with file_path → log line written', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, {
      tool_name: 'Edit',
      tool_input: { file_path: 'lib/bar.js', old_string: 'a', new_string: 'b' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const contents = await fs.readFile(todayLog(root), 'utf8');
    assert.match(contents, /Edit: lib\/bar\.js/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-11: destructive Bash → log line written', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const contents = await fs.readFile(todayLog(root), 'utf8');
    assert.match(contents, /Bash: git push origin main/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-11: benign Bash (ls) → no log file created', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.equal(r.stdout, '', 'expected zero stdout for benign Bash');
    let exists = true;
    try { await fs.access(todayLog(root)); } catch { exists = false; }
    assert.equal(exists, false, 'audit log should not be created for benign Bash');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('malformed stdin JSON → exits clean, no log written', async () => {
  const root = await setupRoot();
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      encoding: 'utf8',
      input: 'not json at all',
      env: { ...process.env, WORKSPACE_ROOT: root }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    let exists = true;
    try { await fs.access(todayLog(root)); } catch { exists = false; }
    assert.equal(exists, false, 'no audit log should be created for unparseable input');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC-11: destructive Bash (rm -rf) → log line written', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/junk' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const contents = await fs.readFile(todayLog(root), 'utf8');
    assert.match(contents, /Bash: rm -rf \/tmp\/junk/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('files_touched: Edit on a session with an existing sidecar appends the path', async () => {
  const root = await setupRoot();
  const sessionId = '11111111-1111-1111-1111-111111111111';
  try {
    await writeSidecar(root, sessionId, { session_id: sessionId, files_touched: [] });
    const r = runHook(root, {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: 'packages/foo/bar.js', old_string: 'a', new_string: 'b' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const sidecar = await readSidecar(root, sessionId);
    assert.deepEqual(sidecar.files_touched, ['packages/foo/bar.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('files_touched: NotebookEdit records notebook_path, not file_path', async () => {
  const root = await setupRoot();
  const sessionId = '22222222-2222-2222-2222-222222222222';
  try {
    await writeSidecar(root, sessionId, { session_id: sessionId, files_touched: [] });
    const r = runHook(root, {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'notebooks/analysis.ipynb', new_source: 'x' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const sidecar = await readSidecar(root, sessionId);
    assert.deepEqual(sidecar.files_touched, ['notebooks/analysis.ipynb']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('files_touched: repeated edits to the same file are deduplicated', async () => {
  const root = await setupRoot();
  const sessionId = '33333333-3333-3333-3333-333333333333';
  try {
    await writeSidecar(root, sessionId, { session_id: sessionId, files_touched: ['packages/foo/bar.js'] });
    const r = runHook(root, {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: 'packages/foo/bar.js', old_string: 'a', new_string: 'b' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const sidecar = await readSidecar(root, sessionId);
    assert.deepEqual(sidecar.files_touched, ['packages/foo/bar.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('files_touched: concurrent hook processes on the same sidecar all survive (no lost update)', async () => {
  const root = await setupRoot();
  const sessionId = '44444444-4444-4444-4444-444444444444';
  try {
    await writeSidecar(root, sessionId, { session_id: sessionId, files_touched: [] });
    const files = Array.from({ length: 8 }, (_, i) => `packages/foo/file-${i}.js`);

    const results = await Promise.all(files.map((filePath) =>
      runHookAsync(root, {
        session_id: sessionId,
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' }
      })
    ));
    results.forEach((r) => assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`));

    const sidecar = await readSidecar(root, sessionId);
    assert.deepEqual([...sidecar.files_touched].sort(), [...files].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('files_touched: missing sidecar (no session yet) does not crash the hook', async () => {
  const root = await setupRoot();
  try {
    const r = runHook(root, {
      session_id: 'no-such-session',
      tool_name: 'Edit',
      tool_input: { file_path: 'packages/foo/bar.js', old_string: 'a', new_string: 'b' }
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    // The audit log side effect should still happen even when the sidecar is absent.
    const contents = await fs.readFile(todayLog(root), 'utf8');
    assert.match(contents, /Edit: packages\/foo\/bar\.js/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Pre-PR verdict + PR summary recording --------------------------------------

const { verdictFromGate, PR_CREATE_RE } = require('../../scripts/hooks/post-tool-use');

async function seedSidecar(root, sessionId, fields) {
  const dir = path.join(root, '.ai-session', 'by-id');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sessionId}.json`),
    JSON.stringify({ session_id: sessionId, ...fields }, null, 2));
  return path.join(dir, `${sessionId}.json`);
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function readValueEvents(root) {
  try {
    const text = await fs.readFile(path.join(root, '.claude', 'logs', 'value-events.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('PR_CREATE_RE matches every supported platform, and nothing else', () => {
  for (const cmd of ['gh pr create --fill', 'glab mr create', 'az repos pr create --id 1', 'bitbucket-pr create']) {
    assert.equal(PR_CREATE_RE.test(cmd), true, cmd);
  }
  for (const cmd of ['gh pr view', 'git push', 'echo gh pr']) {
    assert.equal(PR_CREATE_RE.test(cmd), false, cmd);
  }
});

test('verdictFromGate returns null unless the gate actually ran', () => {
  assert.equal(verdictFromGate({ jira_ticket: 'PROJ-1' }), null, 'no gate status');
  assert.equal(verdictFromGate({ verify_local: 'pending', jira_ticket: 'PROJ-1' }), null, 'not a real outcome');
  assert.equal(verdictFromGate({ verify_local: 'passed' }), null, 'no task id');
});

test('verdictFromGate maps gate status to a verdict and is idempotent', () => {
  const passed = verdictFromGate({ verify_local: 'passed', jira_ticket: 'PROJ-1', project: 'api-service' });
  assert.deepEqual(passed, { taskId: 'PROJ-1', verdict: 'PASS', pass: 1, project: 'api-service' });

  const failed = verdictFromGate({ verify_local: 'failed', jira_ticket: 'PROJ-1', project: 'api-service' });
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.pass, 0);

  const already = verdictFromGate({
    verify_local: 'passed', jira_ticket: 'PROJ-1', pre_pr_verdict_recorded: 'PROJ-1',
  });
  assert.equal(already, null, 'a recorded ticket is never re-recorded');
});

test('a PR-create command records a verifier_verdict and marks the sidecar', async () => {
  const root = await setupRoot();
  try {
    const sidecar = await seedSidecar(root, 'pr-1', {
      verify_local: 'passed', jira_ticket: 'PROJ-1', project: 'api-service',
    });
    const r = runHook(root, {
      session_id: 'pr-1', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' },
    });
    assert.equal(r.status, 0);

    const verdicts = (await readValueEvents(root)).filter((e) => e.type === 'verifier_verdict');
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].details.verdict, 'PASS');
    assert.equal(verdicts[0].details.panel, 'pre-pr-gate');
    assert.equal(verdicts[0].details.taskId, 'PROJ-1');

    assert.equal((await readJson(sidecar)).pre_pr_verdict_recorded, 'PROJ-1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a second PR-create command does not double-record the verdict', async () => {
  const root = await setupRoot();
  try {
    await seedSidecar(root, 'pr-2', { verify_local: 'passed', jira_ticket: 'PROJ-2' });
    const payload = {
      session_id: 'pr-2', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' },
    };
    runHook(root, payload);
    runHook(root, payload);

    const verdicts = (await readValueEvents(root)).filter((e) => e.type === 'verifier_verdict');
    assert.equal(verdicts.length, 1, 'idempotent across repeated PR commands');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a non-PR Bash command records no verdict', async () => {
  const root = await setupRoot();
  try {
    await seedSidecar(root, 'pr-3', { verify_local: 'passed', jira_ticket: 'PROJ-3' });
    runHook(root, {
      session_id: 'pr-3', tool_name: 'Bash', tool_input: { command: 'gh pr view 42' },
    });

    const verdicts = (await readValueEvents(root)).filter((e) => e.type === 'verifier_verdict');
    assert.equal(verdicts.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a PR-create with no gate outcome leaves the sidecar untouched', async () => {
  const root = await setupRoot();
  try {
    const sidecar = await seedSidecar(root, 'pr-4', { jira_ticket: 'PROJ-4' });
    runHook(root, {
      session_id: 'pr-4', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' },
    });

    const after = await readJson(sidecar);
    assert.equal('pre_pr_verdict_recorded' in after, false, 'no gate ran -> nothing recorded');
    assert.equal((await readValueEvents(root)).filter((e) => e.type === 'verifier_verdict').length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
