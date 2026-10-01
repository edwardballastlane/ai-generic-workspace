'use strict';

/**
 * summary-quality — decide whether a `session_summary` observation is worth
 * writing locally and, more importantly, worth SHARING with the team.
 *
 * Why this exists: session summaries are produced by the session-stop fallback
 * (scripts/hooks/session-stop.js) from `deriveTaskSummary`, which grabs the best
 * available signal (commit subjects → resume note → ticket → first user prompt).
 * That heuristic pulls in noise that pollutes shared team memory:
 *
 *   - PROMPT LEAK  — Lane runs its own headless `claude -p` calls (commit-message
 *     generation, ExpeL rule extraction/validation). Those sessions' first user
 *     turn IS the agent's system prompt ("You are extracting ACTIONABLE RULES…"),
 *     which gets captured as the "task". Internal plumbing, never a real task.
 *   - LOG-SESSION  — auto-commit sessions whose only window commit is
 *     "chore: log session <hash>"; the prefix is stripped to "log session <hash>".
 *   - BARE TICKET  — a title that is nothing but "PROJ-123"; no context, and the
 *     ticket is already carried structurally on the session_end event.
 *   - FOLLOW-UP    — a mid-conversation aside ("can you show me this in a table…")
 *     captured as if it were the session's task.
 *   - SENSITIVE    — matches a project-declared sensitive-data pattern (see
 *     `.ai-memory/memory-policy.json`); never shared beyond this machine.
 *
 * Domain-neutral: the sensitive-data patterns are declared per workspace, not
 * baked in. Callable from both the hook (gate at write time) and memory-export
 * (gate at share time).
 */

const fs = require('node:fs');
const path = require('node:path');

// Internal agent/system-prompt leak: headless calls whose first user turn is the
// instruction itself. Anchored to the START so ordinary tasks that merely mention
// these words mid-sentence are not dropped.
const PROMPT_LEAK_RE =
  /^\s*(you are\b|return only\b|evaluate this\b|reply with (only|just)\b|given the following\b|here (is|are) the\b|your task is\b|respond with\b)/i;
const PROMPT_LEAK_CONTAINS_RE = /\bactionable rules\b|\brule validator\b/i;

// Auto-commit / log-session sessions carry no task.
const LOG_SESSION_RE = /^\s*log session\b|\bsession [0-9a-f]{8}\b/i;

// A title that is nothing but a ticket key — "PROJ-123", "ABC-99" — no context.
const BARE_TICKET_RE = /^\s*(?:[A-Z]{2,}-)\d+\s*$/;

// Conversational follow-ups captured as a session task. English and Spanish
// fillers both appear because the workspace is used bilingually; these are
// generic conversational openers, not any one project's vocabulary.
const FOLLOWUP_RE =
  /^\s*(can you|could you|would you|please\b|show me|drop the|give me|tell me|dame\b|hazme\b|sigamos\b|ok\b|okay\b|yes\b|no\b|continue\b|thanks\b|gracias\b)/i;

const MIN_TITLE_LEN = 10;

/**
 * Classify a session-summary-shaped observation.
 *
 * @param {{title?: string, content?: string, source?: string}} obs
 * @returns {{ok: boolean, reason: string}} ok=false when it should NOT be shared;
 *   `reason` is one of: too-short | prompt-leak | log-session | bare-ticket |
 *   followup | sensitive-data | '' (ok).
 */
function classifySummary(obs = {}) {
  const title = String((obs && obs.title) || '').trim();
  const content = String((obs && obs.content) || '');

  if (title.length < MIN_TITLE_LEN) return { ok: false, reason: 'too-short' };
  if (PROMPT_LEAK_RE.test(title) || PROMPT_LEAK_CONTAINS_RE.test(title)) {
    return { ok: false, reason: 'prompt-leak' };
  }
  if (LOG_SESSION_RE.test(title)) return { ok: false, reason: 'log-session' };
  if (BARE_TICKET_RE.test(title)) return { ok: false, reason: 'bare-ticket' };
  if (FOLLOWUP_RE.test(title)) return { ok: false, reason: 'followup' };
  if (containsSensitiveData({ title, content })) {
    return { ok: false, reason: 'sensitive-data' };
  }
  return { ok: true, reason: '' };
}

/**
 * True when a session_summary is noise that should not pollute shared memory.
 * Non-session_summary observations are never treated as noise here (callers pass
 * only summaries, but this stays safe if they don't).
 *
 * @param {{type?: string, title?: string, content?: string}} obs
 * @returns {boolean}
 */
function isNoiseSummary(obs = {}) {
  if (obs && obs.type && obs.type !== 'session_summary') return false;
  return !classifySummary(obs).ok;
}

// --- Sensitive-data export gate (all observation types, not just summaries) ---
// TWO independent gates, because "sensitive" has two very different shapes:
//
//  1. CREDENTIALS are universally sensitive. Nothing has to be declared for an
//     API key or password to be unsafe to publish, so this half is ALWAYS ON and
//     is never waived by `exemptPatterns`. It matters because the export path is
//     fully automatic: the agent is told to call mem_save proactively, every Stop
//     exports the local chunk, and auto-commit + auto-push send it to the team
//     remote. Without this, a credential the agent recorded would be published
//     with no human in the loop. Reuses the same detector the pre-tool-use guard
//     uses, so one definition of "looks like a secret" covers both paths.
//
//  2. DOMAIN markers are declared per workspace in `.ai-memory/memory-policy.json`,
//     because what counts as sensitive there is a property of the project, not of Lane:
//
//   { "sensitivePatterns": ["\\bFO\\d{3,}\\b", "\\bcost basis\\b"],
//     "exemptPatterns":    ["@example\\.", "sandbox"] }
//
//     With no policy file no DOMAIN gating happens — a generic workspace has no
//     domain to protect, and inventing markers would silently drop legitimate
//     summaries. `exemptPatterns` wins over `sensitivePatterns` so demo/test
//     fixtures, which read as domain-sensitive but are not, keep their knowledge.
//     It does NOT waive gate 1.

const DEFAULT_EXEMPT = ['\\bdemo\\b', 'test\\s+account', '@example\\.', 'sandbox'];

let policyCache = null;

function policyPath(rootDir) {
  return path.join(rootDir || workspaceRoot(), '.ai-memory', 'memory-policy.json');
}

function workspaceRoot() {
  return path.resolve(__dirname, '..', '..');
}

function compile(patterns) {
  const usable = [];
  for (const p of patterns) {
    try { usable.push(new RegExp(p, 'i')); } catch { /* a bad pattern must not break the gate */ }
  }
  return usable;
}

/**
 * Load the workspace's sensitive-data policy. Cached: the hook and memory-export
 * both call the gate per observation, and the file never changes mid-run.
 *
 * @param {string} [rootDir] workspace root (tests pass a tempdir)
 * @returns {{sensitive: RegExp[], exempt: RegExp[]}}
 */
function loadPolicy(rootDir) {
  if (!rootDir && policyCache) return policyCache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(policyPath(rootDir), 'utf8')); } catch { raw = {}; }
  const sensitive = compile(Array.isArray(raw.sensitivePatterns) ? raw.sensitivePatterns : []);
  const exemptSrc = Array.isArray(raw.exemptPatterns) ? raw.exemptPatterns : DEFAULT_EXEMPT;
  const policy = { sensitive, exempt: compile(exemptSrc) };
  if (!rootDir) policyCache = policy;
  return policy;
}

function resetPolicyCache() {
  policyCache = null;
}

/**
 * True when an observation carries a credential, or matches a workspace-declared
 * domain pattern, and therefore must stay local. Credentials are never waived by
 * `exemptPatterns`; domain matches are.
 *
 * @param {{title?: string, content?: string}} obs
 * @param {string} [rootDir] workspace root (tests pass a tempdir)
 * @returns {boolean}
 */
function containsSensitiveData(obs = {}, rootDir) {
  const blob = `${(obs && obs.title) || ''} ${(obs && obs.content) || ''}`;
  if (containsCredential(blob)) return true;

  const { sensitive, exempt } = loadPolicy(rootDir);
  if (sensitive.length === 0) return false;
  if (!sensitive.some((re) => re.test(blob))) return false;
  return !exempt.some((re) => re.test(blob));
}

/**
 * Credential half of the gate — always on, never exempted. Isolated so the
 * detector import cannot break the domain half if heuristics is unavailable;
 * on failure it fails CLOSED for nothing (returns false) but the domain gate
 * still applies.
 *
 * @param {string} blob
 * @returns {boolean}
 */
function containsCredential(blob) {
  try {
    const { looksLikeSecret, looksLikeShellSecret } = require('./heuristics');
    return looksLikeSecret(blob) || looksLikeShellSecret(blob);
  } catch {
    return false;
  }
}

// --- Project inference (fills the empty `project` field for board/filter) -------
// The known-project list is whatever is registered under `agent/_projects/`
// (CLAUDE.md rule 2), so it tracks the workspace instead of a baked-in list.

let projectsCache = null;

/**
 * Registered project slugs, read from `agent/_projects/`. Cached per process.
 *
 * @param {string} [rootDir] workspace root (tests pass a tempdir)
 * @returns {string[]}
 */
function knownProjects(rootDir) {
  if (!rootDir && projectsCache) return projectsCache;
  let names = [];
  try {
    names = fs.readdirSync(path.join(rootDir || workspaceRoot(), 'agent', '_projects'))
      .filter((n) => !n.startsWith('.'))
      .sort((a, b) => b.length - a.length);   // longest first: "api-service-web" before "api-service"
  } catch { names = []; }
  if (!rootDir) projectsCache = names;
  return names;
}

function resetProjectsCache() {
  projectsCache = null;
}

/**
 * Best-effort project for an observation: its existing `project` if set, else the
 * first registered project slug mentioned in the title/content, else ''. Never
 * guesses beyond the registered list — an unknown project stays empty rather
 * than mislabeled.
 *
 * @param {{project?: string, title?: string, content?: string}} obs
 * @param {string} [rootDir] workspace root (tests pass a tempdir)
 * @returns {string}
 */
function inferProject(obs = {}, rootDir) {
  const existing = String((obs && obs.project) || '').trim();
  if (existing) return existing;
  const blob = `${(obs && obs.title) || ''} ${(obs && obs.content) || ''}`.toLowerCase();
  for (const p of knownProjects(rootDir)) if (blob.includes(p.toLowerCase())) return p;
  return '';
}

module.exports = {
  classifySummary, isNoiseSummary, containsSensitiveData, containsCredential, inferProject,
  knownProjects, loadPolicy, resetPolicyCache, resetProjectsCache,
};
