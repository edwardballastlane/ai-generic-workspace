/* eslint-disable no-empty */

// fresh-context-impl.js — Snapshot generation logic extracted from
// scripts/fresh-context.js so other Node hooks (notably pre-compact.js, T7)
// can call run({ sessionId, note, workspaceRoot }) in-process without
// re-spawning the CLI.
//
// The wrapper at scripts/fresh-context.js still owns argv/stdin/help/summary;
// this module owns the write side (sidecar + workflow + git → snapshot).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const KEEP_RECENT = 20;

function paths(workspaceRoot) {
  const sessionDir = path.join(workspaceRoot, '.ai-session');
  return {
    sessionDir,
    sidecarDir: path.join(sessionDir, 'by-id'),
    snapshotDir: path.join(sessionDir, 'resume'),
    currentFile: path.join(sessionDir, 'current.yaml'),
  };
}

// ─── YAML mini-parser (top-level scalars only — see spec §6.1) ────────────────
function parseSimpleYaml(text, keys) {
  const result = {};
  for (const key of keys) {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    result[key] = m ? m[1].replace(/^["']|["']$/g, '').trim() : '-';
  }
  return result;
}

function resolveSidecar(sidecarDir, sessionIdArg) {
  if (sessionIdArg) {
    const p = path.join(sidecarDir, `${sessionIdArg}.json`);
    if (fs.existsSync(p)) return { path: p, sessionId: sessionIdArg };
  }
  const envId = process.env.CLAUDE_SESSION_ID;
  if (envId) {
    const p = path.join(sidecarDir, `${envId}.json`);
    if (fs.existsSync(p)) return { path: p, sessionId: envId };
  }
  let entries;
  try { entries = fs.readdirSync(sidecarDir); } catch { return { path: '', sessionId: '' }; }
  const candidates = entries
    .filter(n => n.endsWith('.json'))
    .map(n => {
      const p = path.join(sidecarDir, n);
      try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return { path: '', sessionId: '' };
  const top = candidates[0].p;
  return { path: top, sessionId: path.basename(top, '.json') };
}

function readSidecar(sidecarPath) {
  const fields = {
    project: '-', prompts: 0, lessons: 0, costUsd: 0,
    linesAdded: 0, linesRemoved: 0,
    startedAt: '-', lastActive: '-', cwd: '-'
  };
  if (!sidecarPath || !fs.existsSync(sidecarPath)) return fields;
  try {
    const json = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    fields.project = json.project || '-';
    fields.prompts = Number(json.prompts || 0);
    fields.lessons = Array.isArray(json.lessons_captured) ? json.lessons_captured.length : 0;
    fields.costUsd = Number(json.cost_usd || 0);
    fields.linesAdded = Number(json.lines_added || 0);
    fields.linesRemoved = Number(json.lines_removed || 0);
    fields.startedAt = json.started_at || '-';
    fields.lastActive = json.last_active || '-';
    fields.cwd = json.cwd || '-';
  } catch {}
  return fields;
}

// Phase B: prefer the per-cc-session yaml at by-id/<sid>.yaml when we have a
// session id; otherwise read the shared current.yaml. Kept as a helper so the
// top-level `run` stays under SonarQube's 50-line ceiling.
function resolveWorkflowSource(sidecarDir, sessionId, currentFile) {
  if (sessionId) {
    const perSession = path.join(sidecarDir, `${sessionId}.yaml`);
    if (fs.existsSync(perSession)) return perSession;
  }
  return currentFile;
}

function readWorkflow(currentFile) {
  if (!fs.existsSync(currentFile)) return null;
  let text;
  try { text = fs.readFileSync(currentFile, 'utf8'); } catch { return null; }
  const w = parseSimpleYaml(text,
    ['workflow', 'phase', 'phase_name', 'agent', 'refined', 'original', 'status']);
  if (w.workflow === '-' || !w.workflow) return null;
  const task = w.refined !== '-' ? w.refined : w.original;
  return {
    workflow: w.workflow,
    phase: `${w.phase} (${w.phase_name})`,
    agent: w.agent,
    task,
    status: w.status
  };
}

function gitOut(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim();
  } catch { return ''; }
}

function readGitState(cwd) {
  const out = { branch: '-', ahead: '-', recent: '', dirty: '' };
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'],
      { stdio: 'ignore' });
  } catch { return out; }

  out.branch = gitOut(cwd, ['branch', '--show-current']) || 'detached';

  let ahead = '';
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', '@{u}'],
      { stdio: 'ignore' });
    ahead = gitOut(cwd, ['rev-list', '--count', '@{u}..HEAD']);
  } catch {
    try {
      execFileSync('git', ['-C', cwd, 'rev-parse', 'main'], { stdio: 'ignore' });
      ahead = gitOut(cwd, ['rev-list', '--count', 'main..HEAD']);
    } catch {}
  }
  if (ahead) out.ahead = ahead;

  out.recent = gitOut(cwd, ['log', '--oneline', '-5']);
  const status = gitOut(cwd, ['status', '--short']);
  out.dirty = status ? status.split('\n').slice(0, 20).join('\n') : '';
  return out;
}

function fmtCost(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function buildCostLine(s) {
  if (s.costUsd > 0) {
    return `**Cost so far**: ${fmtCost(s.costUsd)} · **Prompts**: ${s.prompts} · **Lines**: +${s.linesAdded} / -${s.linesRemoved}`;
  }
  return `**Prompts**: ${s.prompts}`;
}

function buildWorkflowSection(w) {
  if (!w) return '';
  return `## Active Workflow\n- **Type**: ${w.workflow}\n- **Phase**: ${w.phase}\n- **Agent**: ${w.agent} (${w.status})\n- **Task**: ${w.task}\n`;
}

function buildNoteSection(note) {
  if (!note) return '';
  return `## Note from previous session\n${note}\n`;
}

function buildLessonsSection(sidecarPath, lessonsCount) {
  if (!lessonsCount || !sidecarPath) return '';
  let ids = '';
  try {
    const json = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (Array.isArray(json.lessons_captured)) ids = json.lessons_captured.join(', ');
  } catch {}
  return `## Lessons captured this session\n${ids}\n`;
}

function composeSnapshot({ now, sessionId, sidecarPath, sidecar, workflow, git, note, cwd }) {
  const costLine = buildCostLine(sidecar);
  const noteSection = buildNoteSection(note);
  const workflowSection = buildWorkflowSection(workflow);
  const lessonsSection = buildLessonsSection(sidecarPath, sidecar.lessons);

  return `# Resume Prompt — paste into a fresh Claude Code session

> Generated ${now}
> Session: \`${sessionId || 'unknown'}\`

I'm resuming work. Here's the context you need.

## Where I was
- **Project**: ${sidecar.project}
- **Branch**: \`${git.branch}\` (${git.ahead} ahead)
- **Cwd**: \`${cwd}\`
- ${costLine}
- **Session age**: started ${sidecar.startedAt}, last active ${sidecar.lastActive}

${noteSection}${workflowSection}${lessonsSection}## Recent commits
\`\`\`
${git.recent || 'none'}
\`\`\`

## Dirty files
\`\`\`
${git.dirty || 'clean'}
\`\`\`

## How to continue
1. Read this whole file first.
2. If the project is non-trivial, skim \`.ai-contexts/${sidecar.project}.yaml\` for stack details.
3. Skim \`.ai-memory/lessons/global.yaml\` and \`.ai-memory/lessons/${sidecar.project}.yaml\` for any rules that apply.
4. Pick up from the dirty files / recent commits above. Ask me to clarify the goal if the note above is unclear.`;
}

function pruneSnapshots(snapshotDir) {
  let entries;
  try { entries = fs.readdirSync(snapshotDir); } catch { return; }
  const md = entries
    .filter(n => n.endsWith('.md') && n !== 'latest.md')
    .map(n => {
      const p = path.join(snapshotDir, n);
      try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of md.slice(KEEP_RECENT)) {
    try { fs.unlinkSync(f.p); } catch {}
  }
}

function tsUtc(date) {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
}

function isoUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Generate a resume snapshot.
 *
 * @param {object} opts
 * @param {string} [opts.sessionId]     - Specific session to resolve; falls back to env / most-recent.
 * @param {string} [opts.note]          - Optional note placed under "Note from previous session".
 * @param {string} [opts.workspaceRoot] - Workspace root; defaults to process.cwd().
 * @param {'save'|'print'} [opts.mode]  - 'save' (default) writes files; 'print' returns content only.
 * @returns {{ filename: string|null, dest: string|null, content: string, sidecar: object, git: object }}
 */
function run(opts = {}) {
  const workspaceRoot = opts.workspaceRoot || process.cwd();
  const mode = opts.mode || 'save';
  const sessionIdArg = opts.sessionId || '';
  const note = opts.note || '';

  const { sidecarDir, snapshotDir, currentFile } = paths(workspaceRoot);

  const { path: sidecarPath, sessionId } = resolveSidecar(sidecarDir, sessionIdArg);
  const sidecar = readSidecar(sidecarPath);
  const workflow = readWorkflow(resolveWorkflowSource(sidecarDir, sessionId, currentFile));

  const cwd = (sidecar.cwd && sidecar.cwd !== '-') ? sidecar.cwd : workspaceRoot;
  const git = readGitState(cwd);

  const now = new Date();
  const content = composeSnapshot({
    now: isoUtc(now),
    sessionId, sidecarPath, sidecar, workflow, git, note, cwd
  });

  if (mode === 'print') {
    return { filename: null, dest: null, content, sidecar, git };
  }

  fs.mkdirSync(snapshotDir, { recursive: true });

  const shortId = (sessionId || 'adhoc').slice(0, 8) || 'adhoc';
  const filename = `${shortId}-${tsUtc(now)}.md`;
  const dest = path.join(snapshotDir, filename);

  fs.writeFileSync(dest, content + '\n');
  // AC-1: latest.md is a PLAIN FILE COPY (not a symlink) — cross-OS safe.
  // Unlink first so we replace any pre-existing symlink (left by the bash
  // original) rather than writing through it to the symlink target.
  // (Regression covered by tests/scripts/fresh-context.test.js — c106307.)
  const latestPath = path.join(snapshotDir, 'latest.md');
  try { fs.unlinkSync(latestPath); } catch {}
  fs.writeFileSync(latestPath, content + '\n');

  pruneSnapshots(snapshotDir);

  return { filename, dest, content, sidecar, git };
}

/**
 * Print the contents of `.ai-session/resume/latest.md` to stdout.
 * Exits 1 with a message to stderr when no snapshot exists.
 *
 * @param {object} [opts]
 * @param {string} [opts.workspaceRoot] - Workspace root; defaults to process.cwd().
 */
function runLatest(opts = {}) {
  const workspaceRoot = opts.workspaceRoot || process.cwd();
  const { snapshotDir } = paths(workspaceRoot);
  const latest = path.join(snapshotDir, 'latest.md');
  if (!fs.existsSync(latest)) {
    process.stderr.write('No snapshot exists yet. Run ./scripts/fresh-context.js first.\n');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(latest, 'utf8'));
  process.exit(0);
}

module.exports = { run, runLatest };
