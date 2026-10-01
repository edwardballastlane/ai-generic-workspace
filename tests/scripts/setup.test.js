'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'setup.js');

async function setupRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'setupjs-'));
  // Pre-create the directories that bash setup itself creates so that
  // we don't race with `git init`/`git add .` when tests don't need it.
  await fsp.mkdir(path.join(root, 'agent', '_projects'), { recursive: true });
  return root;
}

function runScript(root, args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LANE_ROOT: root,
      // Default: tests run with NO_COLOR set unless the case explicitly clears it.
      NO_COLOR: opts.noColor === false ? '' : '1',
      ...(opts.env || {}),
    },
    input: opts.input || undefined,
    timeout: 30_000,
  });
}

// ── AC-1: interactive run via spawnSync writes settings.yaml ────────────────

test('AC-1: interactive run writes .ai-config/settings.yaml', async () => {
  const root = await setupRoot();
  try {
    // Prompt order in runInteractive():
    //   1. reconfigure? — only if settings.yaml already exists; SKIPPED here
    //   2. Jira ticket prefix:                  → "TEST"
    //   3. Workspace name [<root-basename>]:    → "ws-test"
    //   4. Select option [1-4]:                 → "4" (skip project setup)
    //   5. Set up Lane Sync now? (y/N):         → "n"
    // Note: each line must be non-empty — Node 24's readline drops the EOL on
    // consecutive empty piped lines, hanging the next question() call.
    const input = ['TEST', 'ws-test', '4', 'n'].join('\n') + '\n';
    const r = runScript(root, [], { input });
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const yamlPath = path.join(root, '.ai-config', 'settings.yaml');
    assert.ok(fs.existsSync(yamlPath), 'settings.yaml created');
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    assert.match(yaml, /version: "1.0"/);
    assert.match(yaml, /setup_completed: true/);
    assert.match(yaml, /workspace_name: "ws-test"/);
    assert.match(yaml, /jira_prefix: "TEST"/);
    assert.match(yaml, /mcp_services:/);
    assert.match(yaml, /context7: true/);

    // .env should have JIRA_PREFIX and WORKSPACE_NAME appended.
    const envBody = fs.readFileSync(path.join(root, '.env'), 'utf8');
    assert.match(envBody, /^JIRA_PREFIX=TEST$/m);
    assert.match(envBody, /^WORKSPACE_NAME=ws-test$/m);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-3: --config-file <path>.yaml writes settings without prompting ───────

test('AC-3: --config-file writes settings.yaml without prompts', async () => {
  const root = await setupRoot();
  try {
    const fixture = path.join(root, 'fixture-settings.yaml');
    const fixtureBody = [
      '# Lane Configuration (test fixture)',
      'version: "1.0"',
      'setup_completed: true',
      'mcp_services:',
      '  context7: true',
      '  figma: false',
      ''
    ].join('\n');
    await fsp.writeFile(fixture, fixtureBody);

    // No stdin: if --config-file fails to skip prompts, the script will
    // hang forever and the spawn timeout will fire (test would fail).
    const r = runScript(root, ['--config-file', fixture]);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);

    const yamlPath = path.join(root, '.ai-config', 'settings.yaml');
    assert.ok(fs.existsSync(yamlPath), 'settings.yaml written');
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    // The fixture body is written verbatim per the implementation.
    assert.match(yaml, /figma: false/, 'fixture body persisted verbatim');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-4: --info prints expected text and exits 0 without modifying files ──

test('AC-4: --info prints MCP service descriptions and does not write files', async () => {
  const root = await setupRoot();
  try {
    const r = runScript(root, ['--info']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /MCP Configuration Info/);
    assert.match(r.stdout, /Context7/);
    assert.match(r.stdout, /Figma/);
    assert.match(r.stdout, /Playwright/);
    assert.match(r.stdout, /Sequential Thinking/);
    assert.match(r.stdout, /Atlassian/);
    assert.match(r.stdout, /\.mcp\.json/);

    // No file should be written by --info.
    assert.equal(fs.existsSync(path.join(root, '.ai-config', 'settings.yaml')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── AC-5: NO_COLOR=1 → no ANSI escape sequences in stdout ──────────────────

test('AC-5: NO_COLOR=1 suppresses ANSI escape sequences', async () => {
  const root = await setupRoot();
  try {
    const r = runScript(root, ['--info'], { env: { NO_COLOR: '1' } });
    assert.equal(r.status, 0);
    // ESC (0x1B) must not appear in stdout when NO_COLOR is set.
    assert.equal(/\x1b\[/.test(r.stdout), false,
      `expected no ANSI escapes when NO_COLOR=1, got: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
