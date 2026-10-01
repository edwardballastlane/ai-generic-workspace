#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { atomicWrite } = require('./_lib/process');

// ── Constants ─────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
// LANE_ROOT override exists solely for integration tests; in normal use the
// script derives the workspace root from its own location on disk.
const ROOT_DIR = process.env.LANE_ROOT || path.dirname(SCRIPT_DIR);
const PROJECTS_DIR = path.join(ROOT_DIR, 'agent', '_projects');
const CONTEXTS_DIR = path.join(ROOT_DIR, '.ai-contexts');
const WORKSPACE_FILE = path.join(ROOT_DIR, 'lane.code-workspace');

// Ensure executable bit (AC-19) — safe no-op when already set.
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

// ── Source-type detection ─────────────────────────────────────────────────────

const RE_GITHUB    = /^(?:https:\/\/github\.com\/|git@github\.com:|github\.com\/)/;
const RE_BITBUCKET = /bitbucket\.org/;
const RE_GITLAB    = /gitlab\./;
const RE_AZURE     = /(?:dev\.azure\.com|visualstudio\.com)/;

function isGithubUrl(s)    { return RE_GITHUB.test(s); }
function isBitbucketUrl(s) { return RE_BITBUCKET.test(s); }
function isGitlabUrl(s)    { return RE_GITLAB.test(s); }
function isAzureUrl(s)     { return RE_AZURE.test(s); }
function isGitUrl(s) {
  return isGithubUrl(s) || isBitbucketUrl(s) || isGitlabUrl(s) || isAzureUrl(s);
}

function isLocalPath(s) {
  if (s.startsWith('/') || s.startsWith('~/') || s === '~' || s.startsWith('./')) {
    return true;
  }
  try { return fs.existsSync(s) && fs.statSync(s).isDirectory(); }
  catch { return false; }
}

function expandHome(s) {
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function detectGitPlatform(remoteUrl) {
  if (!remoteUrl) return { platform: 'other', cli: 'git', workspace: '' };
  if (isBitbucketUrl(remoteUrl)) {
    const m = remoteUrl.match(/bitbucket\.org[:/]([^/]+)\//);
    return { platform: 'bitbucket', cli: 'curl', workspace: m ? m[1] : '' };
  }
  if (isGitlabUrl(remoteUrl)) return { platform: 'gitlab', cli: 'glab', workspace: '' };
  if (isAzureUrl(remoteUrl))  return { platform: 'azure',  cli: 'az',   workspace: '' };
  if (isGithubUrl(remoteUrl)) return { platform: 'github', cli: 'gh',   workspace: '' };
  return { platform: 'other', cli: 'git', workspace: '' };
}

function getProjectName(source) {
  if (isGitUrl(source)) {
    return path.basename(source).replace(/\.git$/, '');
  }
  if (isLocalPath(source)) {
    return path.basename(expandHome(source).replace(/\/+$/, ''));
  }
  return source;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function gitRemoteUrl(projectPath) {
  try {
    if (!fs.existsSync(path.join(projectPath, '.git'))) return '';
    return execFileSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function detectDefaultBranch(projectPath) {
  if (!fs.existsSync(path.join(projectPath, '.git'))) return 'main';
  try {
    const head = execFileSync('git', ['-C', projectPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = head.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch { /* fall through */ }
  for (const b of ['main', 'master', 'dev', 'develop']) {
    try {
      execFileSync('git', ['-C', projectPath, 'show-ref', '--verify', '--quiet',
        `refs/remotes/origin/${b}`], { stdio: 'ignore' });
      return b;
    } catch { /* try next */ }
  }
  return 'main';
}

// ── Context YAML write ────────────────────────────────────────────────────────

function stripGitBlock(existing) {
  // Replaces bash sed `/^git:/,/^[a-z]/`. The Node `inGit` flag handles EOF correctly:
  // a git block at end-of-file is fully removed, while the bash sed range never closes.
  const lines = existing.split('\n');
  const out = [];
  let inGit = false;
  for (const line of lines) {
    if (/^git:/.test(line))               { inGit = true;  continue; }
    if (inGit && /^[a-zA-Z]/.test(line))  { inGit = false; }
    if (!inGit) out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '');
}

function buildGitBlock({ platform, cli, defaultBranch, workspace }) {
  const lines = [
    '',
    '# ============================================',
    '# GIT CONFIGURATION',
    '# Auto-detected from remote URL',
    '# ============================================',
    'git:',
    `  platform: "${platform}"`,
    `  cli: "${cli}"`,
    `  default_branch: "${defaultBranch}"`,
  ];
  if (workspace) lines.push(`  workspace: "${workspace}"`);
  return lines.join('\n') + '\n';
}

function buildHeader(projectName) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return [
    '# AI Project Context',
    '# Auto-generated by add-project',
    `# Full context: ./scripts/generate-context ${projectName}`,
    '',
    'version: "2.0"',
    `generated: "${ts}"`,
    `project: "${projectName}"`,
    '',
  ].join('\n');
}

async function saveGitConfig(projectName, projectPath) {
  const contextFile = path.join(CONTEXTS_DIR, `${projectName}.yaml`);
  const remoteUrl = gitRemoteUrl(projectPath);
  const { platform, cli, workspace } = detectGitPlatform(remoteUrl);
  const defaultBranch = detectDefaultBranch(projectPath);

  await fsp.mkdir(CONTEXTS_DIR, { recursive: true });

  let header;
  if (fs.existsSync(contextFile)) {
    const existing = fs.readFileSync(contextFile, 'utf8');
    header = /^git:/m.test(existing) ? stripGitBlock(existing) : existing.replace(/\s+$/, '');
  } else {
    header = buildHeader(projectName);
  }

  const gitBlock = buildGitBlock({ platform, cli, defaultBranch, workspace });
  await atomicWrite(contextFile, header + '\n' + gitBlock);

  process.stdout.write('\n');
  process.stdout.write(`${C.BLUE}Git Configuration:${C.NC}\n`);
  process.stdout.write(`  Platform:       ${C.GREEN}${platform}${C.NC}\n`);
  process.stdout.write(`  CLI:            ${cli}\n`);
  process.stdout.write(`  Default Branch: ${defaultBranch}\n`);
  if (workspace) process.stdout.write(`  Workspace:      ${workspace}\n`);
  process.stdout.write(`  ${C.DIM}Saved to: .ai-contexts/${projectName}.yaml${C.NC}\n`);
  return { platform, defaultBranch };
}

// ── lane.code-workspace update ────────────────────────────────────────────────

async function updateWorkspaceFile(projectName, projectDir) {
  if (!fs.existsSync(WORKSPACE_FILE)) return;
  let ws;
  try { ws = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); }
  catch {
    process.stdout.write(`${C.YELLOW}!${C.NC} Could not parse lane.code-workspace\n`);
    return;
  }
  ws.folders = ws.folders || [];
  if (ws.folders.some(f => f && f.name === projectName)) return;

  // For symlinks, point the workspace entry at the real path so VS Code follows it.
  let actualPath = projectDir;
  try {
    if (fs.lstatSync(projectDir).isSymbolicLink()) {
      actualPath = fs.realpathSync(projectDir);
    }
  } catch { /* keep projectDir */ }

  const relPath = path.relative(path.dirname(WORKSPACE_FILE), actualPath);
  ws.folders.push({ name: projectName, path: relPath });
  try {
    await atomicWrite(WORKSPACE_FILE, JSON.stringify(ws, null, 2) + '\n');
    process.stdout.write(`${C.GREEN}+${C.NC} Updated lane.code-workspace\n`);
  } catch {
    process.stdout.write(`${C.YELLOW}!${C.NC} Could not update lane.code-workspace\n`);
  }
}

// ── Source handlers ───────────────────────────────────────────────────────────

function ensureProjectsDir() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function handleGitUrl(source, destDir) {
  process.stdout.write(`${C.GREEN}==>${C.NC} Cloning from: ${source}\n`);
  execFileSync('git', ['clone', source, destDir], { stdio: 'inherit' });
  process.stdout.write(`${C.GREEN}+${C.NC} Cloned to: ${destDir}\n`);
}

function handleLocalPath(source, destDir, copyMode) {
  const expanded = expandHome(source);
  let resolved;
  try { resolved = fs.realpathSync(expanded); }
  catch { resolved = path.resolve(expanded); }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    process.stderr.write(`${C.RED}Error: Directory not found: ${source}${C.NC}\n`);
    process.exit(1);
  }

  if (copyMode) {
    process.stdout.write(`${C.GREEN}==>${C.NC} Copying project: ${resolved}\n`);
    fs.cpSync(resolved, destDir, { recursive: true, dereference: true });
    process.stdout.write(`${C.GREEN}+${C.NC} Copied to: ${destDir}\n`);
    return destDir;
  }

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  process.stdout.write(`${C.GREEN}==>${C.NC} Symlinking project: ${resolved}\n`);
  fs.symlinkSync(resolved, destDir, symlinkType);
  if (!fs.lstatSync(destDir).isSymbolicLink()) {
    process.stderr.write(`${C.RED}Error: link verification failed${C.NC}\n`);
    process.exit(1);
  }
  if (symlinkType === 'junction') {
    process.stdout.write(`${C.GREEN}+${C.NC} linked (junction): ${destDir} -> ${resolved}\n`);
  } else {
    process.stdout.write(`${C.GREEN}+${C.NC} Symlinked: ${destDir} -> ${resolved}\n`);
  }
  return resolved;
}

function handleNewProject(projectName, destDir) {
  process.stdout.write(`${C.GREEN}==>${C.NC} Creating new project: ${projectName}\n`);
  fs.mkdirSync(path.join(destDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(destDir, 'src'),  { recursive: true });
  try { execFileSync('git', ['init', destDir], { stdio: 'ignore' }); } catch { /* ignore */ }

  const today = new Date().toISOString().slice(0, 10);
  const readme = [
    `# ${projectName}`,
    '',
    `Created: ${today}`,
    '',
    '## Overview',
    '',
    '[Add project description]',
    '',
    '## Quick Start',
    '',
    '```bash',
    `cd agent/_projects/${projectName}`,
    '# Add your setup commands',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(destDir, 'README.md'), readme);
  process.stdout.write(`${C.GREEN}+${C.NC} Created at: ${destDir}\n`);
}

// ── Usage / arg parsing ───────────────────────────────────────────────────────

function showUsage(stream = process.stdout) {
  stream.write([
    'Usage: ./scripts/add-project.js [--copy] <source> [project-name]',
    '',
    'Arguments:',
    '  source        Git URL (GitHub/Bitbucket/GitLab/Azure), local path, or new project name',
    '  project-name  Optional custom name (defaults to repo/folder name)',
    '',
    'Options:',
    '  --copy        Copy files instead of symlink (local paths only)',
    '',
    'Examples:',
    '  ./scripts/add-project.js my-new-app',
    '  ./scripts/add-project.js ~/code/my-react-app',
    '  ./scripts/add-project.js https://github.com/user/repo',
    '  ./scripts/add-project.js --copy ~/code/my-project',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { copyMode: false, source: null, customName: null };
  let i = 0;
  while (i < argv.length && argv[i].startsWith('--')) {
    if (argv[i] === '--copy') { args.copyMode = true; i++; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { args.help = true; return args; }
    process.stderr.write(`${C.RED}Unknown flag: ${argv[i]}${C.NC}\n`);
    process.exit(1);
  }
  args.source = argv[i] || null;
  args.customName = argv[i + 1] || null;
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { showUsage(); return; }
  if (!args.source) {
    showUsage(process.stderr);
    process.exit(1);
  }

  const source = args.source;
  const projectName = args.customName || getProjectName(source);
  const projectDir = path.join(PROJECTS_DIR, projectName);

  if (fs.existsSync(projectDir) || (() => {
    try { return fs.lstatSync(projectDir) && true; } catch { return false; }
  })()) {
    let isLink = false;
    try { isLink = fs.lstatSync(projectDir).isSymbolicLink(); } catch { /* ignore */ }
    if (isLink) {
      const real = (() => { try { return fs.realpathSync(projectDir); } catch { return projectDir; } })();
      process.stdout.write(`${C.BLUE}Project '${projectName}' already linked to:${C.NC}\n  ${real}\n`);
    } else {
      process.stdout.write(`${C.BLUE}Project '${projectName}' already exists at:${C.NC}\n  ${projectDir}\n`);
    }
    return;
  }

  ensureProjectsDir();

  let pathForGitConfig = projectDir;
  if (isGitUrl(source)) {
    handleGitUrl(source, projectDir);
    pathForGitConfig = projectDir;
  } else if (isLocalPath(source)) {
    const linkTarget = handleLocalPath(source, projectDir, args.copyMode);
    pathForGitConfig = args.copyMode ? projectDir : linkTarget;
  } else {
    handleNewProject(projectName, projectDir);
    pathForGitConfig = projectDir;
  }

  await saveGitConfig(projectName, pathForGitConfig);
  await updateWorkspaceFile(projectName, projectDir);

  process.stdout.write('\n');
  process.stdout.write(`${C.BLUE}Next steps:${C.NC}\n`);
  process.stdout.write(`  /work-ticket "Your first task for ${projectName}"\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`${C.RED}Error: ${err.message}${C.NC}\n`);
    process.exit(1);
  });
}

module.exports = {
  isGithubUrl, isBitbucketUrl, isGitlabUrl, isAzureUrl, isGitUrl,
  isLocalPath, expandHome, getProjectName, detectGitPlatform,
  stripGitBlock,
};
