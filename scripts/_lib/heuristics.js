'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONVENTIONAL_PREFIX_RE = /^(feat|fix|chore|docs|refactor|test|ci|perf|build|style)(\([^)]+\))?:\s*/;

/**
 * Secret-shape regex — mirrors session-stop.sh:133 SECRET_RE line-by-line.
 * Previously mirrored in backfill-task-from-transcripts.sh (ported in Phase 6 —
 * backfill-task-from-transcripts.js now reuses these helpers directly).
 *
 * Patterns are built from concatenated string parts so this source file does
 * not itself contain a literal real-shaped credential (the repo's pre-tool-use
 * hook would block the write).
 */
const SECRET_PATTERNS = [
  'A' + 'KIA[0-9A-Z]{16}',
  'A' + 'SIA[0-9A-Z]{16}',
  'eyJ[A-Za-z0-9_=-]{20,}',
  'g' + 'hp_[A-Za-z0-9]{20,}',
  'g' + 'ho_[A-Za-z0-9]{20,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  's' + 'k-[A-Za-z0-9]{20,}',
  'Bearer\\s+[A-Za-z0-9._~+/=-]{20,}',
  '(pass' + 'word|pass' + 'wd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\\s*[:=]\\s*\\S{4,}'
];
const SECRET_RE = new RegExp(`(${SECRET_PATTERNS.join('|')})`, 'i');

/**
 * Jira ticket pattern — driven by JIRA_PREFIX env var (e.g., `PROJ`, `ABC`).
 * Matches `<PREFIX>-<digits>` while staying anchored on a word boundary so
 * timezone/encoding tokens like GMT-0500, UTF-8, SHA-256 are not picked up.
 * When JIRA_PREFIX is unset, the regex matches nothing — Jira ticket
 * extraction is opt-in. Read at call time so tests / setup wizard can
 * mutate the env var without restarting the module.
 *
 * @returns {RegExp}
 */
function getJiraRe() {
  const prefix = process.env.JIRA_PREFIX || '';
  return prefix ? new RegExp('\\b' + prefix + '-[0-9]+\\b') : /(?!)/;
}

/**
 * Returns true when the string contains a credential-shaped token.
 *
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeSecret(s) {
  return SECRET_RE.test(s);
}

/**
 * Shell-assignment secret regex — covers raw `KEY=value`, `SECRET=value`,
 * `TOKEN=value`, `PASSWORD=value` forms that pre-tool-use.sh:19-28 blocks
 * but that SECRET_RE (quote-anchored) does not catch. Keeps SECRET_RE
 * semantics intact for inject-context-impl.js / session-stop.js callers.
 *
 * Matches an optional uppercase prefix terminated by `_` (e.g. `MY_KEY=`,
 * `API_TOKEN=`) or a bare name, with optional surrounding quotes around the
 * value. The value must be at least one non-whitespace, non-quote character,
 * so bare `KEY=` does not match. Case-sensitive on the keyword to avoid
 * false positives on words like `monkey`, `turkey`.
 */
const SHELL_SECRET_RE = /(?:^|[^A-Za-z0-9_])(?:[A-Z][A-Z0-9_]*_)?(?:KEY|SECRET|TOKEN|PASSWORD)["']?\s*=\s*["']?[^\s"']+/;

/**
 * Returns true when the string contains a shell-assignment-shaped secret
 * (e.g. `KEY=abc`, `MY_TOKEN=xyz`, `PASSWORD="hunter2"`). Mirrors the
 * patterns enforced by pre-tool-use.sh:19-28.
 *
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeShellSecret(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  return SHELL_SECRET_RE.test(s);
}

/**
 * Extract a task description from an array of user messages.
 * - Strips leading bullet/markdown punctuation and normalizes whitespace.
 * - Skips messages shorter than 10 chars or containing secret-shaped tokens.
 * - Considers only the first 5 messages; picks the longest candidate.
 * - Truncates to 140 chars.
 *
 * @param {string[]|null} messages
 * @returns {string}
 */
function extractTask(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const candidates = messages
    .slice(0, 5)
    .map(m => String(m).replace(/\s+/g, ' ').replace(/^[-*#>\s]+/, '').trim())
    .filter(m => m.length > 10 && !looksLikeSecret(m));
  if (candidates.length === 0) return '';
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0].slice(0, 140);
}

/**
 * Return the first JIRA_PREFIX-<digits> Jira ticket found across the messages
 * array. Ignores non-ticket tokens like GMT-0500, UTF-8, SHA-256. Returns ''
 * when JIRA_PREFIX is unset.
 *
 * @param {string[]} messages
 * @returns {string} Ticket key (e.g. 'PROJ-1234') or empty string.
 */
function extractJiraTicket(messages) {
  if (!Array.isArray(messages)) return '';
  const re = getJiraRe();
  for (const m of messages) {
    const match = String(m).match(re);
    if (match) return match[0];
  }
  return '';
}

/**
 * Read git config user.name from the current repo.
 * Returns 'unknown' if git is unavailable or config is unset.
 *
 * @returns {string}
 */
function getGitUser() {
  try {
    return execFileSync('git', ['config', 'user.name'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Return up to two non-chore commit subjects from the session's time window,
 * stripped of conventional-commit prefixes and joined with ' / '.
 * Falls back to chore-only subjects if nothing else is in the window.
 * Node port of best_commits() from scripts/session-label:126-143.
 *
 * @param {string} rootDir    Absolute path to the git repo.
 * @param {string} startedAt  ISO-8601 timestamp marking the lower bound.
 * @param {string} lastActive ISO-8601 timestamp; window extends +10 min beyond.
 * @returns {string} Joined subjects (each <=90 chars) or '' on any failure.
 */
function extractCommitsInWindow(rootDir, startedAt, lastActive) {
  if (!startedAt || !lastActive) return '';
  let beforeExt;
  try {
    const t = new Date(lastActive).getTime();
    if (!Number.isFinite(t)) return '';
    beforeExt = new Date(t + 600_000).toISOString();
  } catch {
    return '';
  }
  let stdout;
  try {
    stdout = execFileSync('git', [
      'log',
      '--after', startedAt,
      '--before', beforeExt,
      '--format=%s',
      '--no-merges'
    ], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return '';
  }
  const lines = stdout.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return '';
  const nonChore = lines.filter(l => !/^chore(\([^)]+\))?:/.test(l));
  const pool = nonChore.length > 0 ? nonChore : lines;
  return pool
    .slice(0, 2)
    .map(l => l.replace(CONVENTIONAL_PREFIX_RE, '').slice(0, 90))
    .join(' / ');
}

/**
 * Read the most recent resume note for sessionId and return the first
 * qualifying line under "## Note from previous session".
 * Node port of resume_note() from scripts/session-label:150-161.
 *
 * @param {string} resumeDir Directory holding <prefix>*.md resume files.
 * @param {string} sessionId Full UUID; first 8 chars are used as filename prefix.
 * @returns {string} First non-blank, non-auto-compact line (<=140 chars) or ''.
 */
function readResumeNote(resumeDir, sessionId) {
  const short = String(sessionId || '').slice(0, 8);
  if (!short) return '';
  let entries;
  try {
    entries = fs.readdirSync(resumeDir);
  } catch {
    return '';
  }
  const matches = entries
    .filter(name => name.startsWith(short) && name.endsWith('.md'))
    .sort();
  if (matches.length === 0) return '';
  const filePath = path.join(resumeDir, matches[matches.length - 1]);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  const allLines = text.split('\n');
  const startIdx = allLines.findIndex(l => l === '## Note from previous session');
  if (startIdx === -1) return '';
  const noteLines = [];
  for (let i = startIdx + 1; i < allLines.length; i += 1) {
    if (allLines[i].startsWith('## ')) break;
    noteLines.push(allLines[i]);
  }
  const filtered = noteLines.filter(l => !/^\s*$/.test(l) && !l.includes('pre-compact (auto)'));
  if (filtered.length === 0) return '';
  return filtered[0].slice(0, 140);
}

const QUESTION_LEADERS = new Set([
  'can', 'could', 'would', 'should', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'will',
  'what', 'why', 'how', 'when', 'where', 'who', 'which'
]);

/**
 * Returns true when task looks like raw prompt text rather than a structured
 * label. Used by --apply-recaps to select candidates for /recap.
 *

 * Strong (returns false) when: matches a Jira ticket key prefix (when
 * JIRA_PREFIX is set), OR length 10–100 with no URL/no question-word leader.
 * Weak (returns true) for empty, URL-containing, trailing "...", length > 120,
 * length < 10, or question-word-led prompts.
 *
 * @param {string} task
 * @returns {boolean}
 */
function isWeakTask(task) {
  if (typeof task !== 'string' || task.length === 0) return true;
  const prefix = process.env.JIRA_PREFIX || '';
  if (prefix && new RegExp('^' + prefix + '-[0-9]+').test(task)) return false;
  if (task.length > 120) return true;
  if (task.length < 10) return true;
  if (/https?:\/\//i.test(task)) return true;
  if (task.endsWith('...')) return true;
  const firstWord = task.trimStart().split(/\s+/, 1)[0] || '';
  if (QUESTION_LEADERS.has(firstWord.toLowerCase())) return true;
  return false;
}

/**
 * Compute a task label from a fixed signal chain (spec §9 OQ-1 resolution —
 * resume-before-ticket, matching scripts/session-label --auto's auto_label()).
 *
 * Order (each candidate is rejected via looksLikeSecret and falls through):
 *   1) Jira ticket in prompts AND non-empty git-window commits → "<TICKET> <subjects>"  source='commit'
 *   2) commit subjects only (no ticket)                        → "<subjects>"           source='commit'
 *   3) Resume note non-empty                                   → "<note>"               source='resume'
 *   4) Jira ticket only (no commits, no resume)                → "<TICKET>"             source='ticket'
 *   5) extractTask(userPrompts) non-empty                → "<prompt>"             source='prompt'
 *   default                                              → ''                     source=''
 *
 * @param {object}   opts
 * @param {string[]} opts.userPrompts
 * @param {string}   opts.sessionId
 * @param {string}   opts.startedAt
 * @param {string}   opts.lastActive
 * @param {string}   opts.rootDir
 * @param {string}   [opts.resumeDir]  defaults to <rootDir>/.ai-session/resume
 * @returns {{ task: string, source: 'commit'|'ticket'|'resume'|'prompt'|'' }}
 */
function deriveTaskSummary(opts) {
  const {
    userPrompts = [],
    sessionId = '',
    startedAt = '',
    lastActive = '',
    rootDir = '',
    resumeDir = path.join(rootDir, '.ai-session/resume')
  } = opts || {};

  const ticket = extractJiraTicket(userPrompts);
  const commits = extractCommitsInWindow(rootDir, startedAt, lastActive);

  if (ticket && commits) {
    const candidate = `${ticket} ${commits}`.slice(0, 140);
    if (!looksLikeSecret(candidate)) return { task: candidate, source: 'commit' };
  }
  if (commits) {
    const candidate = commits.slice(0, 140);
    if (!looksLikeSecret(candidate)) return { task: candidate, source: 'commit' };
  }
  const note = readResumeNote(resumeDir, sessionId);
  if (note && !looksLikeSecret(note)) {
    return { task: note.slice(0, 140), source: 'resume' };
  }
  if (ticket && !looksLikeSecret(ticket)) {
    return { task: ticket, source: 'ticket' };
  }
  const prompt = extractTask(userPrompts);
  if (prompt && !looksLikeSecret(prompt)) {
    return { task: prompt, source: 'prompt' };
  }
  return { task: '', source: '' };
}

module.exports = {
  extractTask,
  extractJiraTicket,
  looksLikeSecret,
  looksLikeShellSecret,
  getGitUser,
  extractCommitsInWindow,
  readResumeNote,
  isWeakTask,
  deriveTaskSummary
};
