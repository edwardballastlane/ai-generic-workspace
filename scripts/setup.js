#!/usr/bin/env node
'use strict';

// setup.js - Lane workspace bootstrap (Phase 7 port of `scripts/setup`).
// Interactive prompts via node:readline. `--config-file <path>` runs
// non-interactively. `--info` prints MCP service descriptions.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT_DIR = __dirname;
// LANE_ROOT override exists solely for integration tests.
const ROOT_DIR = process.env.LANE_ROOT || path.dirname(SCRIPT_DIR);
const CONFIG_DIR = path.join(ROOT_DIR, '.ai-config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.yaml');
const PROJECTS_DIR = path.join(ROOT_DIR, 'agent', '_projects');

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const ORANGE = useColor ? '\x1b[38;5;208m' : '';
const WHITE = useColor ? '\x1b[1;37m' : '';
const BOLD = useColor ? '\x1b[1m' : '';
const DIM = useColor ? '\x1b[2m' : '';
const NC = useColor ? '\x1b[0m' : '';

function out(s) { process.stdout.write(s); }
function outln(s = '') { process.stdout.write(s + '\n'); }

function printStep(msg)    { outln(`${ORANGE}==>${NC} ${msg}`); }
function printInfo(msg)    { outln(`${WHITE}   →${NC} ${msg}`); }
function printSuccess(msg) { outln(`${ORANGE}✓${NC} ${msg}`); }
function printWarning(msg) { outln(`${ORANGE}⚠${NC} ${msg}`); }
function printError(msg)   { outln(`${ORANGE}✗${NC} ${msg}`); }

function printBanner() {
  outln(`${ORANGE}`);
  outln('╔══════════════════════════════════════╗');
  outln(`║   ${WHITE}Lane${ORANGE} Setup                       ║`);
  outln(`║   ${WHITE}Phase-Based Development${ORANGE}            ║`);
  outln('╚══════════════════════════════════════╝');
  outln(`${NC}`);
}

// ── parseSimpleYaml: copy-paste from scripts/list-projects.js:53-63 ──
function parseSimpleYaml(text, keys) {
  const result = {};
  for (const key of keys) {
    const m = text.match(new RegExp(`^[\\t ]*${key}:\\s*(.+)$`, 'm'));
    result[key] = m ? m[1].replace(/^["']|["']$/g, '').trim() : '-';
  }
  return result;
}

// ── readline wrapper ─────────────────────────────────────────────────
// Buffers `line` events into a queue so that piped stdin (which closes after
// EOF on Node 20+) still serves multiple sequential ask() calls. TTY input
// keeps working unchanged because `line` events fire per Enter keystroke.
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queued = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()('');
  });
  return {
    ask(question) {
      process.stdout.write(question);
      return new Promise((resolve) => {
        if (queued.length > 0) return resolve(queued.shift());
        if (closed) return resolve('');
        waiters.push(resolve);
      });
    },
    // Idempotent: safe to call before spawning an interactive child (to
    // release stdin) and again from the runInteractive `finally`.
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    }
  };
}

// ── Quick-start banner (mirrors bash `show_quick_start`) ─────────────
function showQuickStart() {
  outln(`${ORANGE}${BOLD}Available Commands${NC}`);
  outln(`${DIM}───────────────────────────────────────────────────────────────────${NC}`);
  outln('');
  outln(`  ${ORANGE}Workflow Commands${NC}`);
  outln(`  ${WHITE}/work-ticket${NC} "task"`);
  outln(`      ${DIM}Auto-selects workflow: Quick (bugs), Full BMAD (features), Enterprise (systems)${NC}`);
  outln(`  ${WHITE}/implement${NC} "task"`);
  outln(`      ${DIM}Skip planning, go straight to coding with Developer agent${NC}`);
  outln(`  ${WHITE}/plan${NC} "task"`);
  outln(`      ${DIM}Start with Architect for design and planning before implementation${NC}`);
  outln('');
  outln(`  ${ORANGE}Creative Tools${NC}`);
  outln(`  ${WHITE}/brainstorm${NC} "topic"`);
  outln(`      ${DIM}6 specialized agents generate diverse ideas and solutions${NC}`);
  outln(`  ${WHITE}/tech-debate${NC} "question"`);
  outln(`      ${DIM}Structured debate between agents to explore technical decisions${NC}`);
  outln('');
  outln(`  ${ORANGE}Epic/PRD Management${NC}`);
  outln(`  ${WHITE}/jira-epic${NC} PROJ-123`);
  outln(`      ${DIM}Fetch Jira epic and child issues, build dependency chain${NC}`);
  outln(`  ${WHITE}/jira-epic${NC} [PRD text or file path]`);
  outln(`      ${DIM}Parse PRD document into tasks with auto-inferred dependencies${NC}`);
  outln('');
  outln(`  ${ORANGE}Project Management${NC}`);
  outln(`  ${WHITE}/add-project${NC} <github-url or path>`);
  outln(`      ${DIM}Add existing project via symlink or clone from Git URL${NC}`);
  outln(`  ${WHITE}./scripts/list-projects${NC}`);
  outln(`      ${DIM}Show all projects in workspace with tech stack info${NC}`);
  outln('');
  outln(`${DIM}───────────────────────────────────────────────────────────────────${NC}`);
  outln('');
  outln(`  ${WHITE}Documentation:${NC} ${DIM}docs/COMMANDS.html${NC}`);
  outln('');
}

// ── --info mode (mirrors bash setup:307-321) ─────────────────────────
function printInfoMode() {
  outln('');
  printStep('MCP Configuration Info');
  outln('');
  outln('This workspace comes with MCP services pre-configured in .mcp.json:');
  outln('');
  outln(`1. ${WHITE}Context7${NC} - Documentation and code examples`);
  outln(`2. ${WHITE}Figma${NC} - Design integration via SSE`);
  outln(`3. ${WHITE}Playwright${NC} - Browser automation`);
  outln(`4. ${WHITE}Sequential Thinking${NC} - Advanced reasoning`);
  outln(`5. ${WHITE}Atlassian${NC} - Jira/Confluence integration`);
  outln('');
  outln(`Configuration file: ${WHITE}.mcp.json${NC}`);
  outln('');
}

// ── Settings YAML body ──────────────────────────────────────────────
function buildSettingsYaml(jiraPrefix, workspaceName) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    '# Lane Configuration',
    `# Generated: ${ts}`,
    '',
    'version: "1.0"',
    'setup_completed: true',
    '',
    `workspace_name: "${workspaceName || ''}"`,
    `jira_prefix: "${jiraPrefix || ''}"`,
    '',
    '# Note: Git platform configuration is now per-project.',
    '# When you add a project with /add-project, the git platform',
    '# is auto-detected from the remote URL and stored in',
    '# .ai-contexts/<project>.yaml',
    '',
    'mcp_services:',
    '  context7: true',
    '  figma: true',
    '  playwright: true',
    '  sequential_thinking: true',
    '  atlassian: true',
    ''
  ].join('\n');
}

function writeSettings(jiraPrefix, workspaceName) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, buildSettingsYaml(jiraPrefix, workspaceName));
  // Ensure JIRA_PREFIX + WORKSPACE_NAME land in .env so hooks pick them up.
  // Append (not overwrite) — preserves any existing keys the user has set.
  syncEnvKeys({ JIRA_PREFIX: jiraPrefix || '', WORKSPACE_NAME: workspaceName || '' });
}

// Ensure the given env keys are present in `.env`. Existing values are kept;
// missing keys are appended. Never overwrites a value the user has already set.
function syncEnvKeys(keys) {
  const envPath = path.join(ROOT_DIR, '.env');
  let body = '';
  try { body = fs.readFileSync(envPath, 'utf8'); } catch { body = ''; }
  const existing = new Set();
  for (const line of body.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m) existing.add(m[1]);
  }
  const additions = [];
  for (const [k, v] of Object.entries(keys)) {
    if (!existing.has(k)) additions.push(`${k}=${v}`);
  }
  if (additions.length === 0) return;
  if (body.length > 0 && !body.endsWith('\n')) body += '\n';
  if (body.length > 0) body += '\n# Added by setup.js\n';
  body += additions.join('\n') + '\n';
  fs.writeFileSync(envPath, body, { mode: 0o600 });
}

// ── Existing-setup branch (mirrors bash check_existing_setup) ────────
async function maybeReconfigure(prompter) {
  if (!fs.existsSync(CONFIG_FILE)) return true;
  outln('');
  printWarning('Setup was already completed.');
  outln('');
  outln('   Current configuration:');
  const existing = fs.readFileSync(CONFIG_FILE, 'utf8');
  for (const line of existing.split('\n')) outln(`   ${line}`);
  outln('');
  const reconfigure = await prompter.ask('   Do you want to reconfigure? (y/N): ');
  if (!/^[Yy]$/.test(reconfigure.trim())) {
    outln('');
    printInfo('Keeping existing configuration.');
    outln('');
    showQuickStart();
    return false;
  }
  outln('');
  return true;
}

// ── Prerequisites check (mirrors bash setup:111-133) ─────────────────
function checkPrereqs() {
  printStep('Checking prerequisites...');
  // Node check — we're already running on Node, so just print version.
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  if (major < 18) {
    printError(`Node.js version 18+ required (found ${nodeVersion})`);
    process.exit(1);
  }
  printSuccess(`Node.js ${nodeVersion} found`);

  try {
    const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
    // Extract version like "git version 2.43.0" → "2.43.0"
    const v = gitVersion.split(' ')[2] || gitVersion;
    printSuccess(`Git ${v} found`);
  } catch {
    printError('Git is not installed');
    process.exit(1);
  }
}

// ── Workspace structure ──────────────────────────────────────────────
function createWorkspaceDirs() {
  printStep('Creating workspace structure...');
  const dirs = [
    path.join(ROOT_DIR, 'agent', '_projects'),
    path.join(ROOT_DIR, '.claude'),
    CONFIG_DIR,
    path.join(ROOT_DIR, '.ai-contexts', 'tasks'),
    path.join(ROOT_DIR, '.ai-session'),
    path.join(ROOT_DIR, '.ai-memory', 'audit'),
    path.join(ROOT_DIR, '.ai-memory', 'sessions'),
    path.join(ROOT_DIR, '.ai-memory', 'lessons'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  printSuccess('Workspace structure ready');
}

function checkMcp() {
  printStep('Checking MCP configuration...');
  if (fs.existsSync(path.join(ROOT_DIR, '.mcp.json'))) {
    printSuccess('MCP configuration found at .mcp.json');
  } else {
    printWarning('MCP configuration not found!');
    printInfo('Expected file: .mcp.json in project root');
  }
}

function installDeps() {
  if (!fs.existsSync(path.join(ROOT_DIR, 'package.json'))) return;
  printStep('Installing dependencies...');
  // `|| true` semantics from bash: don't abort if npm fails.
  spawnSync('npm', ['install', '--silent'], { cwd: ROOT_DIR, stdio: 'ignore' });
  printSuccess('Dependencies installed');
}

function gitInit() {
  printStep('Checking git repository...');
  if (fs.existsSync(path.join(ROOT_DIR, '.git'))) {
    printSuccess('Git repository already initialized');
    return;
  }
  printInfo('Initializing git repository...');
  try {
    execFileSync('git', ['init'], { cwd: ROOT_DIR, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: ROOT_DIR, stdio: 'ignore' });
    printSuccess('Git repository initialized');
  } catch (e) {
    printError(`Git init failed: ${e.message}`);
  }
}

function countProjects() {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() || e.isSymbolicLink()).length;
  } catch { return 0; }
}

// ── Project picker (mirrors bash setup:216-272) ──────────────────────
async function projectPicker(prompter) {
  const count = countProjects();
  if (count > 0) {
    printSuccess(`Found ${count} project(s) in workspace`);
    outln('');
    // Run list-projects to print summary; ignore failures.
    const lp = path.join(SCRIPT_DIR, 'list-projects');
    if (fs.existsSync(lp)) {
      const r = spawnSync(lp, [], { encoding: 'utf8' });
      if (r.stdout) {
        const lines = r.stdout.split('\n').slice(0, 20);
        for (const l of lines) outln(l);
      }
    }
    return;
  }

  outln('');
  printWarning('No projects found in workspace!');
  outln('');
  outln('  You need to add at least one project to get started.');
  outln('');
  outln(`  ${ORANGE}Options:${NC}`);
  outln(`    ${WHITE}1)${NC} Add existing local project`);
  outln(`    ${WHITE}2)${NC} Clone from Git URL`);
  outln(`    ${WHITE}3)${NC} Create new empty project`);
  outln(`    ${WHITE}4)${NC} Skip for now`);
  outln('');
  const choice = (await prompter.ask('  Select option [1-4]: ')).trim();

  switch (choice) {
    case '1': await pickLocal(prompter); break;
    case '2': await pickGit(prompter); break;
    case '3': await pickNew(prompter); break;
    case '4':
      printInfo('Skipping project setup');
      printInfo('Run /add-project later to add a project');
      break;
    default:
      printInfo('Skipping project setup');
  }
}

async function pickLocal(prompter) {
  outln('');
  // Reprompt loop on invalid path (AC-6, mirrors bash setup:233-237).
  let projectPath;
  while (true) {
    projectPath = (await prompter.ask('  Enter path to existing project: ')).trim();
    if (projectPath && fs.existsSync(projectPath)) {
      try {
        if (fs.statSync(projectPath).isDirectory()) break;
      } catch { /* fall through to reprompt */ }
    }
    printError('Invalid path');
  }
  const defaultName = path.basename(projectPath);
  const customName = (await prompter.ask(`  Project name [${defaultName}]: `)).trim();
  const projectName = customName || defaultName;
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const dest = path.join(PROJECTS_DIR, projectName);
  try { fs.unlinkSync(dest); } catch { /* not present */ }
  fs.symlinkSync(projectPath, dest);
  printSuccess(`Added project: ${projectName} (symlinked)`);
}

async function pickGit(prompter) {
  outln('');
  // Reprompt loop on invalid URL format (AC-6).
  let gitUrl;
  while (true) {
    gitUrl = (await prompter.ask('  Enter Git URL: ')).trim();
    if (isValidGitUrl(gitUrl)) break;
    printError('Invalid Git URL');
  }
  const defaultName = path.basename(gitUrl).replace(/\.git$/, '');
  const customName = (await prompter.ask(`  Project name [${defaultName}]: `)).trim();
  const projectName = customName || defaultName;
  outln('');
  printInfo('Cloning repository...');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const dest = path.join(PROJECTS_DIR, projectName);
  try {
    execFileSync('git', ['clone', gitUrl, dest], { stdio: 'inherit' });
    printSuccess(`Cloned project: ${projectName}`);
  } catch (e) {
    printError(`Clone failed: ${e.message}`);
  }
}

async function pickNew(prompter) {
  outln('');
  const projectName = (await prompter.ask('  Enter new project name: ')).trim();
  if (!projectName) return;
  fs.mkdirSync(path.join(PROJECTS_DIR, projectName), { recursive: true });
  printSuccess(`Created project: ${projectName}`);
}

function isValidGitUrl(url) {
  if (!url) return false;
  // Match common git URL forms: https://, git@host:, git://, ssh://
  return /^(?:https?:\/\/|git@[^:]+:|git:\/\/|ssh:\/\/).+/.test(url);
}

// ── Find Git Bash on Windows ─────────────────────────────────────────
// `bash` in PATH may resolve to the WSL launcher (which fails when WSL has
// no distro). Walk up from each git.exe returned by `where git` until we
// find bin\bash.exe — that's the Git Bash binary.
function findWindowsBash() {
  try {
    const r = spawnSync('where', ['git'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return null;
    for (const gitExe of r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      let dir = path.dirname(gitExe);
      for (let i = 0; i < 4; i++) {
        const candidate = path.join(dir, 'bin', 'bash.exe');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* fall through */ }
  return null;
}

// ── Sync prompt (mirrors bash setup:296-302) ─────────────────────────
async function maybeSyncSetup(prompter) {
  outln('');
  printStep('Cross-Machine Sync (Optional)');
  printInfo('Sync lessons and memory across your computers.');
  outln('');
  const syncAns = await prompter.ask('  Set up Lane Sync now? (y/N): ');
  if (/^[Yy]$/.test(syncAns.trim())) {
    const sync = path.join(SCRIPT_DIR, 'sync');
    if (fs.existsSync(sync)) {
      // Release stdin before handing control to the interactive `sync init`
      // wizard. While our readline interface is open it owns stdin and keeps
      // the stream paused/buffered, so a child spawned with stdio:'inherit'
      // never receives keystrokes and the CLI appears frozen.
      prompter.close();
      if (process.platform === 'win32') {
        const bashExe = findWindowsBash();
        if (bashExe) {
          spawnSync(bashExe, [sync, 'init'], { stdio: 'inherit' });
        } else {
          printWarning('Could not find Git Bash. Run manually: bash scripts/sync init');
        }
      } else {
        spawnSync(sync, ['init'], { stdio: 'inherit' });
      }
    }
  }
}

// ── Argv parsing ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { mode: 'interactive', configFile: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--info') { out.mode = 'info'; continue; }
    if (a === '--config-file') {
      out.mode = 'config-file';
      out.configFile = argv[++i] || '';
      continue;
    }
    if (a === '-h' || a === '--help') { out.mode = 'help'; continue; }
  }
  return out;
}

function printHelp() {
  outln('setup.js — Lane workspace bootstrap');
  outln('');
  outln('Usage:');
  outln('  node ./scripts/setup.js                       Interactive setup');
  outln('  node ./scripts/setup.js --config-file <path>  Non-interactive (YAML)');
  outln('  node ./scripts/setup.js --info                Print MCP service info');
  outln('');
}

// ── --config-file (AC-3): skip ALL prompts ───────────────────────────
function runConfigFile(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    process.stderr.write(`setup: --config-file path not found: ${configPath}\n`);
    process.exit(1);
  }
  const text = fs.readFileSync(configPath, 'utf8');
  const parsed = parseSimpleYaml(text, ['version', 'setup_completed']);
  // Validate at least one expected key is present; otherwise the file isn't a settings YAML.
  if (parsed.version === '-' && parsed.setup_completed === '-') {
    process.stderr.write('setup: --config-file YAML missing required keys (version, setup_completed)\n');
    process.exit(1);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Write the config-file content verbatim — it's already a valid settings.yaml.
  fs.writeFileSync(CONFIG_FILE, text);
  printSuccess(`Configuration written to ${CONFIG_FILE}`);
}

// ── Workspace config prompts (Jira prefix + workspace name) ─────────
async function promptWorkspaceConfig(prompter) {
  outln('');
  printStep('Workspace configuration');
  outln('');
  outln(`  ${DIM}Jira ticket prefix is used to extract ticket IDs from your prompts${NC}`);
  outln(`  ${DIM}and commit messages (e.g. "PROJ" matches PROJ-1234). Leave blank${NC}`);
  outln(`  ${DIM}to disable Jira ticket extraction.${NC}`);
  outln('');
  const rawPrefix = (await prompter.ask('  Jira ticket prefix (e.g., PROJ): ')).trim();
  const jiraPrefix = rawPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '');

  outln('');
  outln(`  ${DIM}Workspace name is used as a prefix for AWS resources created by${NC}`);
  outln(`  ${DIM}the optional token-dashboard infra (S3 bucket, CloudFront OAC).${NC}`);
  outln('');
  const defaultName = path.basename(ROOT_DIR);
  const rawName = (await prompter.ask(`  Workspace name [${defaultName}]: `)).trim();
  const workspaceName = (rawName || defaultName).toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return { jiraPrefix, workspaceName };
}

// ── Main interactive flow ────────────────────────────────────────────
async function runInteractive() {
  printBanner();
  checkPrereqs();
  const prompter = makePrompter();
  try {
    const proceed = await maybeReconfigure(prompter);
    if (!proceed) {
      await maybeSyncSetup(prompter);
      return;
    }

    createWorkspaceDirs();
    checkMcp();
    installDeps();
    gitInit();

    const { jiraPrefix, workspaceName } = await promptWorkspaceConfig(prompter);

    printStep('Saving configuration...');
    writeSettings(jiraPrefix, workspaceName);
    printSuccess(`Configuration saved to ${path.relative(ROOT_DIR, CONFIG_FILE)}`);
    outln('');

    printStep('Checking projects...');
    await projectPicker(prompter);

    outln('');
    outln(`${ORANGE}╔══════════════════════════════════════╗${NC}`);
    outln(`${ORANGE}║     ${WHITE}Setup Complete!${ORANGE} 🎉               ║${NC}`);
    outln(`${ORANGE}╚══════════════════════════════════════╝${NC}`);
    outln('');
    outln(`${WHITE}Configuration Summary:${NC}`);
    outln(`  ${ORANGE}✓${NC} Workspace structure ready`);
    outln(`  ${ORANGE}✓${NC} MCP services configured`);
    outln(`  ${ORANGE}✓${NC} Config File: .ai-config/settings.yaml`);
    outln('');
    outln(`${WHITE}Next Step:${NC}`);
    outln(`  Add a project: ${ORANGE}/add-project${NC} ~/path/to/project`);
    outln(`  ${DIM}(Git platform will be auto-detected from remote URL)${NC}`);
    outln('');

    await maybeSyncSetup(prompter);
    showQuickStart();
  } finally {
    prompter.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { printHelp(); return; }
  if (args.mode === 'info') { printInfoMode(); return; }
  if (args.mode === 'config-file') { runConfigFile(args.configFile); return; }
  await runInteractive();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`setup: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

module.exports = { parseSimpleYaml, buildSettingsYaml, isValidGitUrl, parseArgs };
