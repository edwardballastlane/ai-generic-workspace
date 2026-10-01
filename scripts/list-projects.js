#!/usr/bin/env node
'use strict';

// list-projects.js - List all projects in the workspace
// Cross-platform Node port of `scripts/list-projects` (155 bash lines).
// Parallelizes `git remote get-url origin` via Promise.all.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(fs.realpathSync(__filename));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'agent', '_projects');
const CONFIG_FILE = path.join(WORKSPACE_ROOT, '.ai-config', 'settings.yaml');
const SHARED_SESSION_FILE = path.join(WORKSPACE_ROOT, '.ai-session', 'current.yaml');

// Phase B: prefer the per-cc-session yaml at by-id/<sid>.yaml when the caller
// exported CLAUDE_SESSION_ID. Falls back to current.yaml otherwise — the
// shell user invoking `./scripts/list-projects` from a non-CC terminal sees
// the most-recently-started session as today.
function resolveSessionFile() {
  const sid = process.env.CLAUDE_SESSION_ID;
  if (sid) {
    const perSession = path.join(WORKSPACE_ROOT, '.ai-session', 'by-id', `${sid}.yaml`);
    if (fs.existsSync(perSession)) return perSession;
  }
  return SHARED_SESSION_FILE;
}
const CONTEXTS_DIR = path.join(WORKSPACE_ROOT, '.ai-contexts');

// AC-19: self-apply executable bit (idempotent, cheap, no-op-ish on Windows).
try { fs.chmodSync(__filename, 0o755); } catch { /* non-fatal */ }

// AC-20 + AC-15: pick palette based on platform/TTY/NO_COLOR.
function pickColors() {
  const noColor = !process.stdout.isTTY || process.env.NO_COLOR;
  if (noColor) {
    return { CYAN: '', PURPLE: '', GREEN: '', YELLOW: '', BLUE: '', RED: '', DIM: '', BOLD: '', NC: '' };
  }
  const isLegacyWin = process.platform === 'win32' && !process.env.WT_SESSION;
  if (isLegacyWin) {
    // 16-color fallback for legacy cmd.exe / PowerShell ISE.
    return {
      CYAN: '\x1b[36m', PURPLE: '\x1b[35m', GREEN: '\x1b[32m', YELLOW: '\x1b[33m',
      BLUE: '\x1b[34m', RED: '\x1b[31m', DIM: '\x1b[2m', BOLD: '\x1b[1m', NC: '\x1b[0m',
    };
  }
  // 24-bit truecolor for macOS/Linux/Windows Terminal (kept simple — same 16-color
  // codes here are universally rendered; 24-bit codes are reserved for statusline).
  return {
    CYAN: '\x1b[0;36m', PURPLE: '\x1b[0;35m', GREEN: '\x1b[0;32m', YELLOW: '\x1b[1;33m',
    BLUE: '\x1b[0;34m', RED: '\x1b[0;31m', DIM: '\x1b[2m', BOLD: '\x1b[1m', NC: '\x1b[0m',
  };
}

const C = pickColors();

/**
 * Inline regex-based YAML mini-parser (per spec §6.1). Extracts only the
 * scalar keys requested. Strips surrounding quotes. Returns `'-'` for missing.
 */
function parseSimpleYaml(text, keys) {
  const result = {};
  for (const key of keys) {
    // Match the key at any indent level — Lane's YAML files nest keys under
    // a parent (e.g. `workflow:\n  status: "..."`). Bash original used
    // `grep "key:"` with no anchor; mirror that behavior.
    const m = text.match(new RegExp(`^[\\t ]*${key}:\\s*(.+)$`, 'm'));
    result[key] = m ? m[1].replace(/^["']|["']$/g, '').trim() : '-';
  }
  return result;
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function printSetupRequired() {
  process.stdout.write('\n');
  process.stdout.write(`${C.YELLOW}╔══════════════════════════════════════════════════════╗${C.NC}\n`);
  process.stdout.write(`${C.YELLOW}║  Setup Required                                      ║${C.NC}\n`);
  process.stdout.write(`${C.YELLOW}╚══════════════════════════════════════════════════════╝${C.NC}\n`);
  process.stdout.write('\n');
  process.stdout.write('  Welcome to Lane!\n\n');
  process.stdout.write('  Before you start, please run the setup script:\n\n');
  process.stdout.write(`    ${C.GREEN}./scripts/setup${C.NC}\n\n`);
  process.stdout.write('  This will configure your Git platform, default branch,\n');
  process.stdout.write('  and help you add your first project.\n\n');
}

function printHeader() {
  const settingsText = readFileSafe(CONFIG_FILE);
  if (settingsText) {
    const { platform } = parseSimpleYaml(settingsText, ['platform']);
    if (platform && platform !== '-') {
      process.stdout.write(`${C.DIM}Git Platform: ${C.NC}${C.CYAN}${platform}${C.NC}\n`);
    }
  }

  const sessionText = readFileSafe(resolveSessionFile());
  if (sessionText) {
    const { status, current_agent } = parseSimpleYaml(sessionText, ['status', 'current_agent']);
    if (status && status !== '-') {
      process.stdout.write(`${C.GREEN}  ▸${C.NC} Active Session: ${C.YELLOW}${status}${C.NC} ${C.DIM}(${current_agent})${C.NC}\n`);
    }
  } else {
    process.stdout.write(`${C.GREEN}  ▸${C.NC} Session: ${C.DIM}None${C.NC}\n`);
  }
  process.stdout.write('\n');
}

/**
 * Map detected frameworks/language to a single skill label, replicating the
 * bash `get_skills_for_project` mapping.
 */
function detectSkill(contextText) {
  if (!contextText) return '';
  const { language } = parseSimpleYaml(contextText, ['language']);
  // Frameworks list: `frameworks: [a, b, c]` — capture inside brackets only.
  const fwMatch = contextText.match(/^\s*frameworks:\s*\[([^\]]*)\]/m);
  const frameworks = fwMatch ? fwMatch[1].toLowerCase() : '';

  if (/nest/.test(frameworks)) return 'nestjs';
  if (/next/.test(frameworks)) return 'nextjs';
  if (/express/.test(frameworks)) return 'express';
  if (/fastapi/.test(frameworks)) return 'python-fastapi';
  if (/dotnet/.test(frameworks)) return 'dotnet';

  const langMap = {
    typescript: 'typescript', javascript: 'typescript',
    python: 'python', csharp: 'dotnet', go: 'golang',
  };
  return langMap[language] || '';
}

function readDescription(projectPath) {
  const readme = path.join(projectPath, 'README.md');
  const desc = path.join(projectPath, 'description.txt');
  try {
    const text = fs.readFileSync(readme, 'utf8');
    const firstLine = text.split('\n')[0] || '';
    return firstLine.replace(/^#+\s*/, '').trim();
  } catch { /* fall through */ }
  try {
    return fs.readFileSync(desc, 'utf8').trim();
  } catch { return ''; }
}

async function getRemoteUrl(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  try { fs.accessSync(gitDir); } catch { return null; }
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { timeout: 3000 });
    return stdout.trim() || 'No remote';
  } catch { return 'No remote'; }
}

/**
 * Build the per-project view object. AC-21: detect both Unix symlinks and
 * Windows junctions via fs.lstatSync().isSymbolicLink() (Node 20+).
 */
async function inspectProject(name) {
  const projectPath = path.join(PROJECTS_DIR, name);
  let isLinked = false;
  let isDir = false;
  try {
    const lst = fs.lstatSync(projectPath);
    isLinked = lst.isSymbolicLink();
    // Resolve through symlink/junction when present so we can read inside.
    const real = isLinked ? fs.statSync(projectPath) : lst;
    isDir = real.isDirectory();
  } catch { return null; }
  if (!isDir) return null;

  const contextFile = path.join(CONTEXTS_DIR, `${name}.yaml`);
  const contextText = readFileSafe(contextFile);
  const skill = detectSkill(contextText);
  const description = readDescription(projectPath);
  const remote = await getRemoteUrl(projectPath);
  return { name, isLinked, skill, description, remote };
}

function renderProject(p) {
  const linkTag = p.isLinked ? ` ${C.DIM}(linked)${C.NC}` : '';
  process.stdout.write(`📁 ${p.name}${linkTag}\n`);
  if (p.skill) process.stdout.write(`   ${C.PURPLE}⚡ ${p.skill}${C.NC}\n`);
  if (p.description) process.stdout.write(`   📖 ${p.description}\n`);
  if (p.remote) process.stdout.write(`   🔗 ${p.remote}\n`);
}

function printFooter() {
  process.stdout.write(`${C.DIM}─────────────────────────────────────────────────${C.NC}\n\n`);
  process.stdout.write(`${C.BLUE}${C.BOLD}Quick Commands${C.NC}\n`);
  process.stdout.write(`  ${C.YELLOW}/work-ticket${C.NC} "task"     ${C.DIM}Smart workflow router${C.NC}\n`);
  process.stdout.write(`  ${C.YELLOW}/jira-epic${C.NC} PPT-123      ${C.DIM}Epic/PRD management${C.NC}\n`);
  process.stdout.write(`  ${C.YELLOW}/brainstorm${C.NC} "topic"    ${C.DIM}Generate ideas${C.NC}\n`);
  process.stdout.write(`  ${C.YELLOW}/tech-debate${C.NC} "question" ${C.DIM}Technical decisions${C.NC}\n`);
  process.stdout.write(`  ${C.YELLOW}/add-project${C.NC} <path>     ${C.DIM}Add project${C.NC}\n`);
  process.stdout.write(`  ${C.YELLOW}/progress${C.NC}               ${C.DIM}View current status${C.NC}\n\n`);
}

async function main() {
  // AC-7: settings.yaml absent -> Setup Required + exit 1.
  try { fs.accessSync(CONFIG_FILE); }
  catch { printSetupRequired(); process.exit(1); }

  printHeader();

  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR);
  } catch {
    process.stdout.write(`No projects directory found at: ${PROJECTS_DIR}\n`);
    process.exit(1);
  }

  process.stdout.write(`${C.BLUE}${C.BOLD}Projects${C.NC}\n`);
  process.stdout.write(`${C.DIM}─────────────────────────────────────────────────${C.NC}\n`);

  if (entries.length === 0) {
    process.stdout.write('No projects found.\n');
    process.exit(0);
  }

  // AC-5: parallel git remote calls via Promise.all.
  const projects = (await Promise.all(entries.map(inspectProject))).filter(Boolean);
  for (const p of projects) renderProject(p);

  printFooter();
}

main().catch(err => {
  process.stderr.write(`list-projects: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
