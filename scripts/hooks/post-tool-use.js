#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { findWorkspaceRoot } = require('./_lib/workspace-root');
const { logValueEvent } = require('./value-logger');
const sessionState = require('../_lib/session-state');

// Commands that open a PR/MR across the platforms Lane targets. Matching any of
// these is the "completion" moment where we auto-record a verifier verdict.
const PR_CREATE_RE = /\b(gh pr create|glab mr create|az repos pr create|bitbucket-pr create)\b/;

function readStdin() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin available */ }
  if (!raw) { try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch { /* R-3: fall back below */ } }
  return raw;
}

function appendAuditLine(root, line) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, '.ai-memory', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${day}.log`), line + '\n');
}

/**
 * Extracts the edited file path from a tool_input, restricted to the
 * documented fields only (Edit.file_path, Write.file_path,
 * NotebookEdit.notebook_path) — never inferred from command text or output.
 *
 * @param {String} tool
 * @param {Object} input
 * @returns {String}
 */
function extractEditedPath (tool, input) {
  if (tool === 'Write' || tool === 'Edit') return String(input.file_path || '');
  if (tool === 'NotebookEdit') return String(input.notebook_path || '');
  return '';
}

/**
 * Appends `filePath` to the session sidecar's `files_touched` array
 * (deduplicated), atomically. No-op if the sidecar doesn't exist yet or
 * the session id can't be resolved — this is a best-effort metric, not a
 * source of truth the rest of the pipeline depends on.
 *
 * The read-modify-write is serialized via updateSidecar's file lock —
 * without it, two PostToolUse hooks firing close together (e.g. an Edit and
 * a Write in quick succession) can each read the sidecar before the other's
 * write lands, and the second write silently drops the first append.
 *
 * @param {String} root
 * @param {String} sessionId
 * @param {String} filePath
 */
async function recordFileTouched (root, sessionId, filePath) {
  if (!sessionId || !filePath) return
  try {
    await sessionState.updateSidecar(root, sessionId, (sidecar) => {
      const files = sessionState.filesTouched(sidecar)
      if (files.includes(filePath)) return undefined
      return { ...sidecar, files_touched: [...files, filePath] }
    })
  } catch { /* best-effort */ }
}

/**
 * Derive a verifier verdict from the deployer's local verify gate, or null when
 * there is nothing real to record. Idempotent per (ticket, session) so a retried
 * PR command does not double-count.
 *
 * @param {Object} sidecar
 * @returns {{taskId: String, verdict: String, pass: Number, project: String}|null}
 */
function verdictFromGate (sidecar) {
  const s = sidecar || {};
  const gate = String(s.verify_local || '').toLowerCase();
  if (gate !== 'passed' && gate !== 'failed') return null;      // no real gate outcome -> record nothing
  const taskId = String(s.jira_ticket || s.task || s.ticket || '').trim();
  if (!taskId) return null;
  if (s.pre_pr_verdict_recorded === taskId) return null;        // idempotent per (ticket, session)
  const pass = gate === 'passed';
  return { taskId, verdict: pass ? 'PASS' : 'FAIL', pass: pass ? 1 : 0, project: String(s.project || 'unknown') };
}

/**
 * On a PR-creation command, write a RICH session_summary from the PR title/description
 * (better than the session-stop fallback's first-user-prompt guess). Deterministic id
 * ("sess_<id>") so it supersedes any thin fallback and so session-stop skips its thin
 * write. Skips noise titles and observations carrying sensitive data. Best-effort;
 * never throws.
 */
async function recordPrSummary (root, sessionId, cmd) {
  if (!sessionId || !PR_CREATE_RE.test(cmd)) return;
  try {
    const { buildPrSummary, sessionSummaryId } = require('../_lib/pr-summary');
    const { isNoiseSummary, containsSensitiveData } = require('../_lib/summary-quality');
    const sidecar = sessionState.readSidecar(root, sessionId) || {};
    const ticket = sessionState.jiraTicket(sidecar);
    const project = sessionState.project(sidecar);
    const filesTouched = sessionState.filesTouched(sidecar);
    const summary = buildPrSummary({ cmd, ticket, project, filesTouched });
    if (!summary) return;
    const obs = { type: 'session_summary', ...summary };
    if (isNoiseSummary(obs) || containsSensitiveData(obs)) return;
    const store = require('../_lib/memory-store');
    store.upsertObservation(root, {
      ...obs,
      sessionId,
      project,
      source: 'pr-create',
      local: true,
    }, { id: sessionSummaryId(sessionId) });
  } catch { /* best-effort */ }
}

/**
 * On a PR-creation command, auto-record a verifier_verdict derived from the
 * deployer's verify_local gate status — so the verifier signal fires on the
 * DEFAULT ticket path, not just inside /swarm-implement. Best-effort; never throws.
 */
async function recordPrePrVerdict (root, sessionId, cmd, transcriptPath) {
  if (!sessionId || !PR_CREATE_RE.test(cmd)) return;
  let decided = null;
  try {
    await sessionState.updateSidecar(root, sessionId, (sidecar) => {
      decided = verdictFromGate(sidecar);
      if (!decided) return undefined;                            // nothing to record -> don't touch the sidecar
      return { ...sidecar, pre_pr_verdict_recorded: decided.taskId };
    });
  } catch { return; }
  if (!decided) return;
  // The ACTUAL model from the session transcript, not a configured/assumed one.
  // 'unknown' when unresolvable — never backfilled. Only read here (PR creation is
  // rare), so the transcript scan doesn't run on every tool call.
  let effectiveModel = 'unknown';
  try {
    if (transcriptPath) {
      const { readTranscript } = require('../_lib/transcript');
      const t = await readTranscript(transcriptPath);
      if (t && t.model) effectiveModel = t.model;
    }
  } catch { /* keep 'unknown' */ }
  logValueEvent('verifier_verdict', 1, {
    taskId: decided.taskId, verdict: decided.verdict, panel: 'pre-pr-gate',
    panelists: 1, passVotes: decided.pass, blockers: decided.pass ? 0 : 1,
    retry: 0, project: decided.project, source: 'post-tool-use', effectiveModel,
  }, sessionId);
}

async function main () {
  const raw = readStdin();
  if (!raw) return;

  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (!payload || typeof payload !== 'object') return;

  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const sessionId = payload.session_id || '';
  const root = findWorkspaceRoot();
  const ts = new Date().toISOString();

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const filePath = extractEditedPath(tool, input);
    if (filePath) {
      appendAuditLine(root, `[${ts}] ${tool}: ${filePath}`);
      await recordFileTouched(root, sessionId, filePath);
    }
  } else if (tool === 'Bash') {
    const cmd = String(input.command || '');
    if (cmd && /(git push|git reset|rm -r|rm -f|mv |chmod |chown )/.test(cmd)) {
      appendAuditLine(root, `[${ts}] Bash: ${cmd}`);
    }
    await recordPrePrVerdict(root, sessionId, cmd, payload.transcript_path || '');
    await recordPrSummary(root, sessionId, cmd);
  }
}

if (require.main === module) {
  main().catch(() => {}).finally(() => process.exit(0));
}

module.exports = { verdictFromGate, PR_CREATE_RE };
