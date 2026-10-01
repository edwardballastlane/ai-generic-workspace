#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const { atomicWrite } = require('./_lib/process');

// ── Constants ─────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
const ROOT_DIR = process.env.LANE_ROOT || path.dirname(SCRIPT_DIR);
const PROJECTS_DIR = path.join(ROOT_DIR, 'agent', '_projects');
const CONTEXTS_DIR = path.join(ROOT_DIR, '.ai-contexts');
const WORKSPACE_FILE = path.join(ROOT_DIR, 'lane.code-workspace');

try { fs.chmodSync(__filename, 0o755); } catch { /* read-only fs */ }

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  GREEN:  USE_COLOR ? '\x1b[0;32m' : '',
  BLUE:   USE_COLOR ? '\x1b[0;34m' : '',
  YELLOW: USE_COLOR ? '\x1b[0;33m' : '',
  RED:    USE_COLOR ? '\x1b[0;31m' : '',
  DIM:    USE_COLOR ? '\x1b[2m'    : '',
  NC:     USE_COLOR ? '\x1b[0m'    : '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// ── Project removal steps ─────────────────────────────────────────────────────

async function removeFromWorkspace(projectName) {
  if (!fs.existsSync(WORKSPACE_FILE)) return;
  let ws;
  try { ws = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); }
  catch {
    process.stdout.write(`${C.YELLOW}!${C.NC} Could not parse lane.code-workspace — skipping\n`);
    return;
  }
  const before = (ws.folders || []).length;
  ws.folders = (ws.folders || []).filter(f => f && f.name !== projectName);
  if (ws.folders.length === before) {
    process.stdout.write(`${C.DIM}  lane.code-workspace — no entry found, skipping${C.NC}\n`);
    return;
  }
  try {
    await atomicWrite(WORKSPACE_FILE, JSON.stringify(ws, null, 2) + '\n');
    process.stdout.write(`${C.GREEN}-${C.NC} Removed from lane.code-workspace\n`);
  } catch {
    process.stdout.write(`${C.YELLOW}!${C.NC} Could not update lane.code-workspace\n`);
  }
}

async function removeContext(projectName) {
  const contextFile = path.join(CONTEXTS_DIR, `${projectName}.yaml`);
  if (!fs.existsSync(contextFile)) {
    process.stdout.write(`${C.DIM}  .ai-contexts/${projectName}.yaml — not found, skipping${C.NC}\n`);
    return;
  }
  await fsp.unlink(contextFile);
  process.stdout.write(`${C.GREEN}-${C.NC} Removed .ai-contexts/${projectName}.yaml\n`);
}

async function removeProjectDir(projectName, projectDir, force) {
  let stat;
  try { stat = fs.lstatSync(projectDir); }
  catch {
    process.stdout.write(`${C.YELLOW}!${C.NC} Project directory not found: ${projectDir}\n`);
    return;
  }

  if (stat.isSymbolicLink()) {
    const real = (() => { try { return fs.realpathSync(projectDir); } catch { return projectDir; } })();
    process.stdout.write(`${C.GREEN}-${C.NC} Removing symlink: ${projectDir} -> ${real}\n`);
    await fsp.unlink(projectDir);
    return;
  }

  // Real directory (cloned repo or new project)
  if (!force) {
    process.stdout.write(`${C.YELLOW}Warning:${C.NC} '${projectName}' is a real directory (cloned or created locally).\n`);
    process.stdout.write(`  Path: ${projectDir}\n`);
    const answer = await ask(`  Permanently delete it? Type the project name to confirm: `);
    if (answer !== projectName) {
      process.stdout.write(`${C.RED}Aborted.${C.NC} Nothing was deleted.\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`${C.GREEN}-${C.NC} Deleting directory: ${projectDir}\n`);
  rmrf(projectDir);
}

// ── Usage / arg parsing ───────────────────────────────────────────────────────

function showUsage(stream = process.stdout) {
  stream.write([
    'Usage: ./scripts/remove-project <project-name> [options]',
    '',
    'Arguments:',
    '  project-name  Name of the project to remove from the workspace',
    '',
    'Options:',
    '  --force       Skip confirmation prompt for real directories',
    '  --dry-run     Show what would be removed without doing it',
    '',
    'Examples:',
    '  ./scripts/remove-project my-app',
    '  ./scripts/remove-project my-app --force',
    '  ./scripts/remove-project my-app --dry-run',
    '',
    'What gets removed:',
    '  - agent/_projects/<project-name>  (symlink removed; dir deleted with confirmation)',
    '  - .ai-contexts/<project-name>.yaml',
    '  - Entry in lane.code-workspace',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { projectName: null, force: false, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f')    { args.force  = true;  continue; }
    if (arg === '--dry-run')                  { args.dryRun = true;  continue; }
    if (arg === '--help' || arg === '-h')     { args.help   = true;  return args; }
    if (arg.startsWith('--')) {
      process.stderr.write(`${C.RED}Unknown flag: ${arg}${C.NC}\n`);
      process.exit(1);
    }
    if (!args.projectName) args.projectName = arg;
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { showUsage(); return; }
  if (!args.projectName) { showUsage(process.stderr); process.exit(1); }

  const { projectName, force, dryRun } = args;
  const projectDir = path.join(PROJECTS_DIR, projectName);

  // Verify project exists at all
  const exists = (() => { try { fs.lstatSync(projectDir); return true; } catch { return false; } })();
  const contextExists = fs.existsSync(path.join(CONTEXTS_DIR, `${projectName}.yaml`));

  if (!exists && !contextExists) {
    process.stderr.write(`${C.RED}Error: Project '${projectName}' not found in this workspace.${C.NC}\n`);
    process.stdout.write(`\nAvailable projects:\n`);
    try {
      const entries = fs.readdirSync(PROJECTS_DIR);
      if (entries.length === 0) {
        process.stdout.write(`  ${C.DIM}(none)${C.NC}\n`);
      } else {
        for (const e of entries.sort()) process.stdout.write(`  ${C.BLUE}${e}${C.NC}\n`);
      }
    } catch { /* ignore */ }
    process.exit(1);
  }

  process.stdout.write(`${C.BLUE}Removing project:${C.NC} ${projectName}\n\n`);

  if (dryRun) {
    process.stdout.write(`${C.YELLOW}[dry-run]${C.NC} Would remove:\n`);
    if (exists) process.stdout.write(`  ${projectDir}\n`);
    if (contextExists) process.stdout.write(`  ${path.join(CONTEXTS_DIR, `${projectName}.yaml`)}\n`);
    let ws;
    try { ws = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); } catch { ws = null; }
    if (ws && (ws.folders || []).some(f => f && f.name === projectName)) {
      process.stdout.write(`  lane.code-workspace entry\n`);
    }
    return;
  }

  if (exists) await removeProjectDir(projectName, projectDir, force);
  await removeContext(projectName);
  await removeFromWorkspace(projectName);

  process.stdout.write(`\n${C.GREEN}Done.${C.NC} Project '${projectName}' removed from workspace.\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`${C.RED}Error: ${err.message}${C.NC}\n`);
    process.exit(1);
  });
}
