/**
 * inject-context-impl.js — Node port of scripts/hooks/inject-context.sh.
 *
 * Exports run({ rawStdin, workspaceRoot }) → string. Replicates ALL logic in
 * inject-context.sh:23-408: stdin parse, session-ID recovery from transcript
 * path, sidecar create/update (atomic), YAML_BOUND multi-terminal guard,
 * Jira priority chain, project detection (4 sources), <no-active-session>
 * and <project-context> XML emit, async sidecar prune.
 *
 * Called both:
 *   - In-process by user-prompt-dispatcher.js (post-Phase-5 T8 refactor):
 *     dispatcher reads stdin once and passes rawStdin in.
 *   - As a standalone hook via the inject-context.js wrapper.
 *
 * Empty/invalid rawStdin → returns '' without writing any sidecar (AC-3).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractJiraTicket } = require('../_lib/heuristics');
const detectedProjectCache = require('./_lib/detected-project');
const { atomicWriteSync } = require('../_lib/process');

/**
 * Extract a `$JIRA_PREFIX-NNN` ticket from the current git branch name. With
 * JIRA_PREFIX unset the pattern matches nothing, so extraction is opt-in.
 * Returns '' on any failure: git not installed, not a repo, detached HEAD, or
 * no match.
 */
function getBranchJira(workspaceRoot) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return extractJiraTicket([branch]) || '';
  } catch {
    return '';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const META_CMDS = [
  'fresh-context', 'session-stats', 'statusline', 'pre-push', 'config',
  'help', 'status', 'agent', 'progress', 'handoff', 'loop', 'schedule',
  'review', 'security-review', 'insights', 'team-onboarding', 'init',
];
const META_CMD_RE = new RegExp(
  `<command-name>/(${META_CMDS.join('|')})</command-name>|^\\s*/(${META_CMDS.join('|')})(\\s|$)`,
  'm'
);

const PRUNE_AGE_MS = 7 * 86400_000;

/**
 * Minimal flat YAML reader — extracts a fixed set of scalar keys regardless of
 * nesting (matches the case-pattern lookup style of inject-context.sh, which
 * does not parse YAML structure). Empty values resolve to ''.
 *
 * Returned shape: { task_original, claude_session_id, jira_ticket, project,
 *   agent, status }.
 */
function parseSimpleYaml(text) {
  const out = {
    task_original: '',
    claude_session_id: '',
    jira_ticket: '',
    project: '',
    agent: '',
    status: '',
  };
  if (typeof text !== 'string') return out;
  const lines = text.split('\n');
  const matchers = [
    ['original', 'task_original'],
    ['claude_session_id', 'claude_session_id'],
    ['jira_ticket', 'jira_ticket'],
    ['project', 'project'],
    ['agent', 'agent'],
    ['status', 'status'],
  ];
  for (const raw of lines) {
    for (const [key, field] of matchers) {
      if (out[field]) continue;
      const idx = raw.indexOf(`${key}:`);
      if (idx === -1) continue;
      // Reject keys that are only a substring of a longer key (e.g. claude_session_id
      // contains 'session_id'). Require the char before the key to be non-word.
      const before = idx === 0 ? '' : raw.charAt(idx - 1);
      if (before && /[A-Za-z0-9_]/.test(before)) continue;
      let val = raw.slice(idx + key.length + 1).trim();
      // Strip trailing inline comment.
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
      // Strip surrounding quotes.
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val) out[field] = val;
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function deriveSessionId(payload) {
  if (payload && typeof payload.session_id === 'string' && payload.session_id) {
    return payload.session_id;
  }
  const tp = payload && typeof payload.transcript_path === 'string'
    ? payload.transcript_path : '';
  if (!tp) return '';
  const base = tp.split(/[\\/]/).pop() || '';
  const uuid = base.endsWith('.jsonl') ? base.slice(0, -6) : base;
  return UUID_RE.test(uuid) ? uuid : '';
}

// Phase B: pick the right session yaml for this prompt and run the
// first-prompt rescue. The per-session file at by-id/<sid>.yaml wins; on
// miss, current.yaml is honored ONLY when its claude_session_id matches
// this session, then promoted to the per-session location so subsequent
// prompts see only per-session state. Encapsulated so the hot-path `run`
// stays under SonarQube's complexity ceiling.
function resolveSessionYaml(sharedYamlFile, sessionYamlFile) {
  let yaml = readYamlIfExists(sessionYamlFile);
  if (yaml) return yaml;
  const sharedYaml = readYamlIfExists(sharedYamlFile);
  if (!sharedYaml) return null;
  // Compare against sessionYamlFile's owner inferred from the basename so the
  // rescue gate stays tight: only promote when current.yaml is bound to this
  // session.
  const targetSid = path.basename(sessionYamlFile, '.yaml');
  if (sharedYaml.claude_session_id !== targetSid) return null;
  try { fs.copyFileSync(sharedYamlFile, sessionYamlFile); } catch { /* best-effort */ }
  return sharedYaml;
}

function readYamlIfExists(yamlPath) {
  try {
    const text = fs.readFileSync(yamlPath, 'utf8');
    return parseSimpleYaml(text);
  } catch {
    return null;
  }
}

function isMetaCommand(prompt) {
  if (!prompt) return false;
  return META_CMD_RE.test(prompt);
}

/**
 * Maybe-prune sidecar files older than 7 days. Gated by .last-prune touchfile
 * (once per calendar day). Async, fire-and-forget — never blocks the hook.
 */
function maybePruneSidecars(sidecarDir) {
  const stamp = path.join(sidecarDir, '.last-prune');
  try {
    const st = fs.statSync(stamp);
    const today = new Date();
    const stampDay = new Date(st.mtimeMs);
    if (
      stampDay.getUTCFullYear() === today.getUTCFullYear() &&
      stampDay.getUTCMonth() === today.getUTCMonth() &&
      stampDay.getUTCDate() === today.getUTCDate()
    ) {
      return;
    }
  } catch {
    // No stamp yet — proceed with prune.
  }

  let entries;
  try {
    entries = fs.readdirSync(sidecarDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(sidecarDir, name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > PRUNE_AGE_MS) {
        fs.unlink(p, () => {});
      }
    } catch { /* skip */ }
  }
  // Touch the stamp synchronously so the same-day check above sees it.
  try {
    const fd = fs.openSync(stamp, 'a');
    const t = new Date();
    fs.futimesSync(fd, t, t);
    fs.closeSync(fd);
  } catch { /* fire-and-forget */ }
}

/**
 * Append a custom-title record to CC's transcript JSONL so /resume picker shows
 * the task. Mirrors inject-context.sh:187-198. Cross-OS slug per R-4.
 */
function maybeAppendCustomTitle({ sidecar, sidecarPath, taskTitle, userCwd, sessionId }) {
  if (!taskTitle || !userCwd) return;
  const lastTitle = (sidecar && sidecar.last_title_written) || '';
  if (lastTitle === taskTitle) return;
  const cwdSlug = userCwd.replace(/[\\/]/g, '-');
  const ccJsonl = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude', 'projects', cwdSlug, `${sessionId}.jsonl`
  );
  if (!fs.existsSync(ccJsonl)) return;
  const record = JSON.stringify({
    type: 'custom-title',
    customTitle: taskTitle,
    sessionId,
  });
  try { fs.appendFileSync(ccJsonl, record + '\n'); } catch { return; }
  try {
    const updated = { ...(sidecar || {}), last_title_written: taskTitle, title_written: true };
    fs.writeFileSync(sidecarPath, JSON.stringify(updated, null, 2));
  } catch { /* best-effort */ }
}

/**
 * Load the skill→project map from .ai-contexts/skill-project-map.json.
 * Returns a flat map of skillName → projectName, or {} on any error.
 */
function loadSkillProjectMap(workspaceRoot) {
  try {
    const raw = fs.readFileSync(
      path.join(workspaceRoot, '.ai-contexts', 'skill-project-map.json'),
      'utf8'
    );
    const obj = JSON.parse(raw);
    const map = {};
    for (const [project, skills] of Object.entries(obj)) {
      for (const skill of skills) {
        map[skill] = project;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Match a prompt against the skill→project map.
 * Looks for <command-name>/skill-name</command-name> or /skill-name as the
 * first token (mirrors how CC serialises skill invocations in the prompt).
 * Returns the mapped project name, or '' if no match.
 */
function matchSkillProject(prompt, skillMap) {
  if (!prompt || !Object.keys(skillMap).length) return '';
  for (const [skill, project] of Object.entries(skillMap)) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `<command-name>\\/${escaped}<\\/command-name>|^\\s*\\/${escaped}(\\s|$)`,
      'm'
    );
    if (re.test(prompt)) return project;
  }
  return '';
}

/**
 * Detect the active project from 5 sources, in priority order:
 *   0. Skill-to-project map (.ai-contexts/skill-project-map.json) — highest priority
 *   1. session yaml (when status != completed)
 *   2. CWD path-segment match against agent/_projects/<name>
 *   3. Prompt text word-boundary match against agent/_projects/<name>
 *   4. Cached .ai-session/detected-project file — gated by session_id so a
 *      parallel terminal's cached value cannot leak into this session
 *
 * Returns { project, source: 'skill'|'yaml'|'cwd'|'prompt'|'detected'|'' }.
 * yaml hits are NOT marked trusted for sidecar stamping; all others are.
 */
function detectProject({ yaml, userCwd, userPrompt, projectsDir, workspaceRoot, sessionId }) {
  let project = '';
  let source = '';

  // Source 0: skill-to-project map (highest priority — overrides yaml/cwd/prompt/detected).
  if (userPrompt && workspaceRoot) {
    const skillMap = loadSkillProjectMap(workspaceRoot);
    const skillProject = matchSkillProject(userPrompt, skillMap);
    if (skillProject) {
      project = skillProject;
      source = 'skill';
    }
  }

  if (!project && yaml && yaml.status !== 'completed' && yaml.project) {
    project = yaml.project;
    source = 'yaml';
  }

  let projects = null;
  const loadProjects = () => {
    if (projects !== null) return projects;
    try {
      projects = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() || d.isSymbolicLink())
        .map(d => d.name)
        .filter(n => n !== '.' && n !== '..' && n !== 'https:' && !n.endsWith('.zip'));
    } catch {
      projects = [];
    }
    return projects;
  };

  if ((!project || project === 'unspecified') && userCwd) {
    const list = loadProjects();
    let best = '';
    for (const name of list) {
      const segRe = new RegExp(
        `[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\\\/]|$)`
      );
      if (segRe.test(userCwd) && name.length > best.length) best = name;
    }
    if (best) {
      project = best;
      source = 'cwd';
    }
  }

  if ((!project || project === 'unspecified') && userPrompt) {
    const list = loadProjects();
    const padded = ' ' + userPrompt.toLowerCase() + ' ';
    let best = '';
    for (const name of list) {
      const lowered = name.toLowerCase();
      const wordRe = new RegExp(
        `[\\s,.!?;:()\\[\\]{}/]${lowered.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,.!?;:()\\[\\]{}/]`
      );
      if (wordRe.test(padded) && lowered.length > best.length) best = lowered;
    }
    if (best) {
      project = best;
      source = 'prompt';
    }
  }

  if (!project || project === 'unspecified') {
    const cached = detectedProjectCache.read(workspaceRoot, sessionId);
    if (cached) {
      project = cached;
      source = 'detected';
    }
  }

  return { project, source };
}

/**
 * Write the per-prompt sidecar (create or merge). Returns the merged sidecar
 * object so downstream code (custom-title append, project stamp) can chain
 * additional updates against it.
 */
function writeSidecar({ sidecarPath, existing, payload, now, yamlBound, taskTitle, trustedJira, clearStaleJira, sessionId }) {
  const isCreate = existing == null;
  const initTask = yamlBound && taskTitle ? taskTitle : '';
  const base = isCreate
    ? {
        session_id: sessionId,
        started_at: now,
        last_active: now,
        cwd: payload.cwd || '',
        task: initTask,
        jira_ticket: trustedJira || '',
        prompts: 1,
        lessons_captured: [],
        files_touched: [],
        cost_usd: 0,
        duration_ms: 0,
        lines_added: 0,
        lines_removed: 0,
      }
    : { ...existing };

  if (!isCreate) {
    base.prompts = (Number(base.prompts) || 0) + 1;
    base.last_active = now;
    base.cwd = payload.cwd || '';
    if (yamlBound && taskTitle) base.task = taskTitle;
    if (trustedJira) base.jira_ticket = trustedJira;
    else if (clearStaleJira) base.jira_ticket = '';
  }

  try { atomicWriteSync(sidecarPath, JSON.stringify(base, null, 2)); }
  catch { /* best-effort */ }
  return base;
}

/**
 * Compute the trusted Jira ticket from per-session sources, applying the
 * priority chain from inject-context.sh:119-148:
 *
 *   YAML_BOUND:   TASK_JIRA > PROMPT_JIRA > yaml.jira_ticket
 *   not bound:    BRANCH_JIRA > PROMPT_JIRA > yaml.jira_ticket
 *
 * BRANCH_JIRA is sourced from `git rev-parse --abbrev-ref HEAD` (see
 * getBranchJira) so a session without a bound task.yaml still gets accurate
 * real-time dashboard attribution from the working branch name.
 */
function computeJiraChain({ yaml, yamlBound, taskTitle, userPrompt, branchJira }) {
  const taskJira = yamlBound && taskTitle ? extractJiraTicket([taskTitle]) : '';
  const promptJira = userPrompt ? extractJiraTicket([userPrompt]) : '';
  const yamlJira = yaml && yaml.jira_ticket ? yaml.jira_ticket : '';

  let trusted = '';
  let clearStale = false;

  if (yamlBound && taskTitle) {
    if (taskJira) trusted = taskJira;
    else if (promptJira) trusted = promptJira;
    // else: bound to a task that names no ticket — leave empty to honor opt-out.
  } else if (branchJira) {
    trusted = branchJira;
  } else if (promptJira) {
    trusted = promptJira;
  } else if (yamlBound && yamlJira) {
    trusted = yamlJira;
  }

  if (yamlBound && taskTitle && !trusted) clearStale = true;

  return { trusted, clearStale };
}

/**
 * Build the <no-active-session> XML block, or return '' when not applicable.
 * Only emits when a project was detected and no active session is bound to
 * THIS CC session.
 */
function buildNoActiveSessionXml({ project, sessionActive, sessionUnbound, isMeta, sessionBoundId, sessionId }) {
  if (!project || project === 'unspecified') return '';
  if (sessionActive || isMeta) return '';
  const lines = [];
  lines.push('');
  lines.push(`<no-active-session project="${project}">`);
  if (sessionUnbound) {
    lines.push('STALE SESSION: .ai-session/current.yaml is marked active but was bound to');
    lines.push(`  claude_session_id="${sessionBoundId}" (current is "${sessionId}").`);
    lines.push('Treat it as no active session — start a new one before doing any work.');
  } else {
    lines.push(`PROJECT DETECTED: ${project} — but NO active session.`);
  }
  lines.push('You MUST auto-start a workflow before doing any work:');
  lines.push('  1. If the user gave an actionable task → run /work-ticket to auto-detect workflow');
  lines.push(`  2. If exploring/discussing → run: ./scripts/start-session quick-flow "<task>" ${project}`);
  lines.push('Do NOT proceed with tool calls (Edit, Write, Bash) until a session is started.');
  lines.push('</no-active-session>');
  return lines.join('\n');
}

function buildProjectContextXml({ project, contextFile }) {
  if (!project || project === 'unspecified') return '';
  let raw;
  try { raw = fs.readFileSync(contextFile, 'utf8'); } catch { return ''; }
  // Extract `language:` field with a flat regex matching the bash logic.
  let lang = '';
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('language:');
    if (idx === -1) continue;
    const before = idx === 0 ? '' : line.charAt(idx - 1);
    if (before && /[A-Za-z0-9_]/.test(before)) continue;
    let val = line.slice(idx + 'language:'.length).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) { lang = val; break; }
  }
  if (!lang) return '';
  return [
    '',
    `<project-context project="${project}">`,
    `Language: ${lang}`,
    `Full context: .ai-contexts/${project}.yaml`,
    '</project-context>',
  ].join('\n');
}

function run({ rawStdin, workspaceRoot }) {
  if (!rawStdin || typeof rawStdin !== 'string') return '';
  let payload;
  try { payload = JSON.parse(rawStdin); } catch { return ''; }
  if (!payload || typeof payload !== 'object') return '';

  const sessionId = deriveSessionId(payload);
  if (!sessionId) return '';

  // Meta-command early-exit: no XML, no sidecar update.
  if (isMetaCommand(payload.prompt || '')) return '';

  const root = workspaceRoot || process.cwd();
  const sharedYamlFile = path.join(root, '.ai-session', 'current.yaml');
  const projectsDir = path.join(root, 'agent', '_projects');
  const sidecarDir = path.join(root, '.ai-session', 'by-id');
  const sidecarPath = path.join(sidecarDir, `${sessionId}.json`);
  const sessionYamlFile = path.join(sidecarDir, `${sessionId}.yaml`);

  try { fs.mkdirSync(sidecarDir, { recursive: true }); } catch { /* best-effort */ }

  const yaml = resolveSessionYaml(sharedYamlFile, sessionYamlFile);
  const yamlBound = !!(
    yaml && yaml.claude_session_id && yaml.claude_session_id === sessionId
  );
  const taskTitle = yamlBound && yaml && yaml.task_original
    ? yaml.task_original.slice(0, 120)
    : '';

  const branchJira = yamlBound ? '' : getBranchJira(root);

  const { trusted: trustedJira, clearStale: clearStaleJira } = computeJiraChain({
    yaml, yamlBound, taskTitle, userPrompt: payload.prompt || '', branchJira,
  });

  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch { /* none */ }

  const merged = writeSidecar({
    sidecarPath,
    existing,
    payload,
    now: nowIso(),
    yamlBound,
    taskTitle,
    trustedJira,
    clearStaleJira,
    sessionId,
  });

  maybeAppendCustomTitle({
    sidecar: merged,
    sidecarPath,
    taskTitle,
    userCwd: payload.cwd || '',
    sessionId,
  });

  // ── project detection (4 sources) ──────────────────────────
  const { project, source: projectSource } = detectProject({
    yaml: yamlBound ? yaml : null,
    userCwd: payload.cwd || '',
    userPrompt: payload.prompt || '',
    projectsDir,
    workspaceRoot: root,
    sessionId,
  });

  // Persist detected project to the cache file when source was per-session.
  // The helper writes the cc session_id alongside so a parallel session in
  // another terminal cannot read this cached value as its own fallback.
  if (project && (projectSource === 'skill' || projectSource === 'cwd' || projectSource === 'prompt')) {
    detectedProjectCache.write(root, sessionId, project);
  }

  // Stamp project onto sidecar when it came from a per-session-trusted source,
  // OR when the yaml is bound to THIS session (not a different terminal's).
  const projectTrusted = projectSource === 'skill'
    || projectSource === 'cwd'
    || projectSource === 'prompt'
    || projectSource === 'detected';
  if (project && project !== 'unspecified' && (projectTrusted || yamlBound)) {
    try {
      const stamped = { ...merged, project };
      fs.writeFileSync(sidecarPath, JSON.stringify(stamped, null, 2));
    } catch { /* best-effort */ }
  }

  // ── session-active check (mirrors inject-context.sh:330-346) ──────────
  let sessionActive = false;
  let sessionUnbound = false;
  const sessionBoundId = (yaml && yaml.claude_session_id) || '';
  if (yaml && (yaml.status === 'active' || yaml.status === 'paused')) {
    if (sessionBoundId && sessionBoundId === sessionId) sessionActive = true;
    else if (!sessionBoundId && !sessionId) sessionActive = true;
    else if (sessionBoundId && sessionBoundId !== sessionId) sessionUnbound = true;
    else sessionActive = true;
  }

  const noActiveBlock = buildNoActiveSessionXml({
    project,
    sessionActive,
    sessionUnbound,
    isMeta: false,
    sessionBoundId,
    sessionId,
  });
  const ctxBlock = buildProjectContextXml({
    project,
    contextFile: path.join(root, '.ai-contexts', `${project}.yaml`),
  });

  // Async sidecar prune (fire-and-forget).
  try { maybePruneSidecars(sidecarDir); } catch { /* best-effort */ }

  const out = [noActiveBlock, ctxBlock].filter(Boolean).join('\n');
  return out;
}

module.exports = { run, parseSimpleYaml, isMetaCommand };
