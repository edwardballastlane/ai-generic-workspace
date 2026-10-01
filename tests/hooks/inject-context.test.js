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

const IMPL = require('../../scripts/hooks/inject-context-impl');
const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'inject-context.js');

const VALID_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_SID = '11111111-2222-3333-4444-555555555555';

async function setupRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'inject-ctx-'));
  await fsp.mkdir(path.join(root, '.ai-session', 'by-id'), { recursive: true });
  await fsp.mkdir(path.join(root, '.ai-contexts'), { recursive: true });
  await fsp.mkdir(path.join(root, 'agent', '_projects'), { recursive: true });
  // CLAUDE.md is the marker findWorkspaceRoot looks for. Tests that spawn the
  // wrapper need it; tests that call run() pass workspaceRoot explicitly.
  await fsp.writeFile(path.join(root, 'CLAUDE.md'), '# test workspace\n');
  return root;
}

async function writeYaml(root, body) {
  await fsp.writeFile(path.join(root, '.ai-session', 'current.yaml'), body);
}

async function readSidecar(root, sid) {
  const p = path.join(root, '.ai-session', 'by-id', `${sid}.json`);
  return JSON.parse(await fsp.readFile(p, 'utf8'));
}

function sidecarExists(root, sid) {
  return fs.existsSync(path.join(root, '.ai-session', 'by-id', `${sid}.json`));
}

// atomicWrite is async — give the rename a tick to land before assertions.
async function flushSidecar() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

test('AC-1: valid payload increments sidecar prompts and stamps last_active', async () => {
  const root = await setupRoot();
  try {
    const payload = {
      session_id: VALID_SID,
      cwd: root,
      prompt: 'fix something',
    };
    const out = IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    assert.equal(typeof out, 'string');
    assert.ok(sidecarExists(root, VALID_SID), 'sidecar must be created');
    const sc = await readSidecar(root, VALID_SID);
    assert.equal(sc.prompts, 1);
    assert.equal(sc.session_id, VALID_SID);
    assert.match(sc.last_active, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(sc.cwd, root);

    // Second invocation — prompts increments to 2.
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc2 = await readSidecar(root, VALID_SID);
    assert.equal(sc2.prompts, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-2: session_id falls back to UUID extracted from transcript_path', async () => {
  const root = await setupRoot();
  try {
    const payload = {
      transcript_path: `/some/dir/${VALID_SID}.jsonl`,
      cwd: root,
      prompt: 'hello',
    };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    assert.ok(sidecarExists(root, VALID_SID), 'sidecar must use UUID from transcript_path');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-3: empty rawStdin returns empty string and writes no sidecar', async () => {
  const root = await setupRoot();
  try {
    const out = IMPL.run({ rawStdin: '', workspaceRoot: root });
    assert.equal(out, '');
    await flushSidecar();
    const entries = await fsp.readdir(path.join(root, '.ai-session', 'by-id'));
    assert.deepEqual(entries.filter(e => e.endsWith('.json')), []);

    // Invalid JSON does the same.
    const out2 = IMPL.run({ rawStdin: 'not json {{{', workspaceRoot: root });
    assert.equal(out2, '');
    await flushSidecar();
    const entries2 = await fsp.readdir(path.join(root, '.ai-session', 'by-id'));
    assert.deepEqual(entries2.filter(e => e.endsWith('.json')), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-4: yaml bound to a different session does NOT leak task or jira_ticket', async () => {
  const root = await setupRoot();
  try {
    await writeYaml(root, [
      'session:',
      `  claude_session_id: "${OTHER_SID}"`,
      '  status: "active"',
      'task:',
      '  original: "PROJ-9999: secret task from another terminal"',
      '  jira_ticket: "PROJ-9999"',
      '  project: "my-backend"',
      '',
    ].join('\n'));
    // Pre-create a project dir so detection has something to find.
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-backend'), { recursive: true });

    const payload = {
      session_id: VALID_SID,
      cwd: root,
      prompt: 'unrelated work',
    };
    const out = IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc = await readSidecar(root, VALID_SID);
    assert.equal(sc.task, '', 'task must NOT inherit from other-terminal yaml');
    assert.equal(sc.jira_ticket, '', 'jira_ticket must NOT inherit from other-terminal yaml');
    // XML still emitted (project label is non-attributive). Output may be
    // empty if no project detected, but no throw is required.
    assert.equal(typeof out, 'string');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-1 (Phase B): per-session yaml at by-id/<sid>.yaml takes precedence over current.yaml', async () => {
  // Simulates the parallel-session race that Phase B closes: terminal B's
  // start-session overwrote current.yaml after terminal A's. Terminal A's
  // per-session yaml at by-id/<A>.yaml still carries A's task — that's the
  // source the hook must honor, not the shared current.yaml that now
  // belongs to B.
  const root = await setupRoot();
  try {
    // Shared current.yaml now bound to terminal B with B's task.
    await writeYaml(root, [
      'session:',
      `  claude_session_id: "${OTHER_SID}"`,
      '  status: "active"',
      'task:',
      '  original: "B-task PROJ-9999"',
      '  jira_ticket: "PROJ-9999"',
      '  project: "my-portal-web"',
      '',
    ].join('\n'));
    // Per-session yaml for terminal A still carries A's task.
    await fsp.writeFile(
      path.join(root, '.ai-session', 'by-id', `${VALID_SID}.yaml`),
      [
        'session:',
        `  claude_session_id: "${VALID_SID}"`,
        '  status: "active"',
        'task:',
        '  original: "A-task PROJ-1111"',
        '  jira_ticket: "PROJ-1111"',
        '  project: "my-backend"',
        '',
      ].join('\n'),
    );
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-backend'), { recursive: true });
    const payload = {
      session_id: VALID_SID,
      cwd: root,
      prompt: 'continuing A-task work',
    };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc = await readSidecar(root, VALID_SID);
    assert.equal(sc.jira_ticket, 'PROJ-1111', 'must read jira from per-session yaml, not shared current.yaml');
    assert.ok(sc.task.includes('A-task') || sc.task === 'A-task PROJ-1111',
      'must read task from per-session yaml, got: ' + sc.task);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-1 (Phase B): first-prompt rescue copies matching current.yaml to by-id/<sid>.yaml', async () => {
  // When start-session ran without a CLAUDE_SESSION_ID env (the common case
  // pre-Phase-B), only current.yaml was written. The first prompt whose
  // session_id matches current.yaml.claude_session_id must promote it.
  const root = await setupRoot();
  try {
    await writeYaml(root, [
      'session:',
      `  claude_session_id: "${VALID_SID}"`,
      '  status: "active"',
      'task:',
      '  original: "rescued task PROJ-7777"',
      '  jira_ticket: "PROJ-7777"',
      '  project: "my-backend"',
      '',
    ].join('\n'));
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-backend'), { recursive: true });
    const perSession = path.join(root, '.ai-session', 'by-id', `${VALID_SID}.yaml`);
    // Per-session yaml must NOT exist before the first prompt.
    assert.equal(fs.existsSync(perSession), false, 'preflight: per-session yaml absent');
    const payload = {
      session_id: VALID_SID,
      cwd: root,
      prompt: 'first prompt of this session',
    };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    assert.equal(fs.existsSync(perSession), true, 'rescue: per-session yaml created');
    const rescued = await fsp.readFile(perSession, 'utf8');
    assert.match(rescued, /PROJ-7777/, 'rescued content matches current.yaml');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-5: yaml bound to same session — task truncated to 120 chars, TASK_JIRA wins', async () => {
  const root = await setupRoot();
  try {
    const longTitle = 'PROJ-1234: ' + 'x'.repeat(200);
    await writeYaml(root, [
      'session:',
      `  claude_session_id: "${VALID_SID}"`,
      '  status: "active"',
      'task:',
      `  original: "${longTitle}"`,
      '  jira_ticket: "PROJ-9999"',
      '',
    ].join('\n'));

    const payload = {
      session_id: VALID_SID,
      cwd: root,
      // PROMPT_JIRA = PROJ-7777 — but TASK_JIRA must win.
      prompt: 'doing PROJ-7777 right now',
    };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc = await readSidecar(root, VALID_SID);
    assert.equal(sc.task.length, 120);
    assert.equal(sc.task, longTitle.slice(0, 120));
    assert.equal(sc.jira_ticket, 'PROJ-1234',
      'TASK_JIRA must outrank PROMPT_JIRA when YAML_BOUND=true and task is set');

    // PROMPT_JIRA fallback when task names no ticket.
    const root2 = await setupRoot();
    try {
      await writeYaml(root2, [
        'session:',
        `  claude_session_id: "${VALID_SID}"`,
        '  status: "active"',
        'task:',
        '  original: "task with no ticket name"',
        '',
      ].join('\n'));
      IMPL.run({
        rawStdin: JSON.stringify({
          session_id: VALID_SID, cwd: root2, prompt: 'also touching PROJ-5555',
        }),
        workspaceRoot: root2,
      });
      await flushSidecar();
      const sc2 = await readSidecar(root2, VALID_SID);
      assert.equal(sc2.jira_ticket, 'PROJ-5555',
        'PROMPT_JIRA fills in when TASK_JIRA empty');
    } finally {
      await fsp.rm(root2, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('M-2: unbound session falls back to BRANCH_JIRA from git branch name', async () => {
  const root = await setupRoot();
  try {
    // Initialize a real git repo with a branch carrying PROJ-1234.
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let r = git('init', '--initial-branch=feat/PROJ-1234-something');
    if (r.status !== 0) {
      // Older git lacks --initial-branch; init then rename.
      git('init');
      git('checkout', '-b', 'feat/PROJ-1234-something');
    }
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('commit', '--allow-empty', '-m', 'init');
    // Confirm branch is what we expect; rename if needed.
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root, encoding: 'utf8',
    }).stdout.trim();
    if (branch !== 'feat/PROJ-1234-something') {
      git('checkout', '-b', 'feat/PROJ-1234-something');
    }

    // No current.yaml bound to this session — YAML_BOUND=false. Prompt names
    // no Jira ticket, so PROMPT_JIRA is empty and BRANCH_JIRA must win.
    const payload = {
      session_id: VALID_SID,
      cwd: root,
      prompt: 'do some unrelated work',
    };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc = await readSidecar(root, VALID_SID);
    assert.equal(sc.jira_ticket, 'PROJ-1234',
      'BRANCH_JIRA must populate jira_ticket when YAML_BOUND=false and prompt has no ticket');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-6: prune fires when stamp absent or older than today; skipped when touched today', async () => {
  const root = await setupRoot();
  try {
    const sidecarDir = path.join(root, '.ai-session', 'by-id');
    const oldSid = '00000000-0000-0000-0000-000000000001';
    const newSid = '00000000-0000-0000-0000-000000000002';
    const oldPath = path.join(sidecarDir, `${oldSid}.json`);
    const newPath = path.join(sidecarDir, `${newSid}.json`);
    await fsp.writeFile(oldPath, '{}');
    await fsp.writeFile(newPath, '{}');
    // Backdate oldSid to 10 days ago, newSid to 1 hour ago.
    const tenDaysAgo = (Date.now() - 10 * 86400_000) / 1000;
    const oneHourAgo = (Date.now() - 3600_000) / 1000;
    fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);
    fs.utimesSync(newPath, oneHourAgo, oneHourAgo);
    // No .last-prune touchfile exists → prune should fire.

    const payload = { session_id: VALID_SID, cwd: root, prompt: 'go' };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    // fs.unlink is async; let it land.
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fs.existsSync(oldPath), false, '7-day-old sidecar must be pruned');
    assert.equal(fs.existsSync(newPath), true, 'fresh sidecar must survive');
    assert.equal(fs.existsSync(path.join(sidecarDir, '.last-prune')), true,
      '.last-prune must be touched after prune');

    // Second invocation with .last-prune fresh: re-create an old file and
    // confirm it survives (prune skipped).
    await fsp.writeFile(oldPath, '{}');
    fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fs.existsSync(oldPath), true,
      'second-invocation prune must skip when .last-prune touched today');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('OQ-4: spawning the wrapper with empty stdin creates no sidecar', async () => {
  const root = await setupRoot();
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, WORKSPACE_ROOT: root },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.equal(r.stdout, '', 'no XML on empty stdin');
    const entries = await fsp.readdir(path.join(root, '.ai-session', 'by-id'));
    assert.deepEqual(entries.filter(e => e.endsWith('.json')), [],
      'no sidecar must be written on empty stdin');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-2 (Phase A): detected-project cache written by another session is NOT used as a fallback', async () => {
  // Simulates the parallel-session race: terminal B's prompt detected
  // my-portal-web and stamped the cache. Terminal A then runs a prompt
  // with no per-prompt project signal — the cache must NOT leak B's project
  // into A's attribution path.
  const root = await setupRoot();
  try {
    // Seed a cache written by OTHER_SID for my-portal-web.
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-portal-web'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.ai-session', 'detected-project'),
      `${OTHER_SID}\nmy-portal-web\n`,
    );
    // Session A submits a prompt with no cwd/skill/prompt project signal.
    const payload = {
      session_id: VALID_SID,
      cwd: '/tmp/unrelated', // not under any project dir
      prompt: 'an unrelated question',
    };
    const out = IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc = await readSidecar(root, VALID_SID);
    assert.notEqual(sc.project, 'my-portal-web', 'session A must not inherit B-cached project');
    assert.equal(typeof out, 'string');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-2 (Phase A): detected-project cache written by the same session IS used as a fallback', async () => {
  // Positive case — the gate only blocks cross-session reads. A session
  // reading its own cached value must still get the cached project.
  const root = await setupRoot();
  try {
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-backend'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.ai-session', 'detected-project'),
      `${VALID_SID}\nmy-backend\n`,
    );
    const payload = {
      session_id: VALID_SID,
      cwd: '/tmp/unrelated',
      prompt: 'continuing work',
    };
    const out = IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const sc = await readSidecar(root, VALID_SID);
    assert.equal(sc.project, 'my-backend', 'session A must see its own cached project');
    assert.equal(typeof out, 'string');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-2 (Phase A): a per-prompt project detection writes the gated 2-line cache format', async () => {
  // Verifies the writer side of the gate: when this prompt detects a project
  // from cwd, the cache file must contain <session_id>\n<project>\n so future
  // sessions can determine ownership.
  const root = await setupRoot();
  try {
    const projDir = path.join(root, 'agent', '_projects', 'my-backend');
    await fsp.mkdir(projDir, { recursive: true });
    const payload = {
      session_id: VALID_SID,
      cwd: projDir,
      prompt: 'starting work',
    };
    IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    const raw = await fsp.readFile(path.join(root, '.ai-session', 'detected-project'), 'utf8');
    const [line1, line2] = raw.split('\n');
    assert.equal(line1, VALID_SID, 'line 1 must be the writer session_id');
    assert.equal(line2, 'my-backend', 'line 2 must be the detected project');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('meta-command prompts skip sidecar updates entirely', async () => {
  const root = await setupRoot();
  try {
    // Create a baseline sidecar to confirm prompts is NOT incremented.
    const sidecarPath = path.join(root, '.ai-session', 'by-id', `${VALID_SID}.json`);
    await fsp.writeFile(sidecarPath, JSON.stringify({
      session_id: VALID_SID, prompts: 5, started_at: '2026-01-01T00:00:00Z',
    }));
    const payload = {
      session_id: VALID_SID,
      cwd: root,
      prompt: '<command-name>/help</command-name>',
    };
    const out = IMPL.run({ rawStdin: JSON.stringify(payload), workspaceRoot: root });
    await flushSidecar();
    assert.equal(out, '');
    const sc = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
    assert.equal(sc.prompts, 5, 'meta-command must not increment prompts');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
