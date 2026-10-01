'use strict';

/**
 * session-state — one typed reader over Lane's per-session state (Mastra's
 * createWorkflowStateReader pattern). The per-session sidecar
 * (`.ai-session/by-id/<id>.json`) was hand-parsed in ~5 places, each re-implementing
 * the path, the try/catch, and the `Array.isArray(s.files_touched) ? … : []` guards —
 * exactly the surface where a field rename or a parse quirk silently breaks a consumer
 * (the dashboard-parser-drift class of bug). Centralize the schema knowledge here so
 * dashboards / hooks / the reaper consume typed accessors instead of raw files.
 *
 * Pure w.r.t. an injected `root` → unit-testable against a tempdir.
 */

const fs = require('node:fs');
const path = require('node:path');

function sidecarDir(root) { return path.join(root, '.ai-session', 'by-id'); }
function sidecarPath(root, sessionId) { return path.join(sidecarDir(root), `${sessionId}.json`); }

/**
 * Read a per-session sidecar. Returns the parsed object, or null if the id is empty,
 * the file is absent, or it fails to parse — the same semantics the call sites
 * hand-rolled, now in one place.
 */
function readSidecar(root, sessionId) {
  if (!sessionId) return null;
  try { return JSON.parse(fs.readFileSync(sidecarPath(root, sessionId), 'utf8')); }
  catch { return null; }
}

// Typed field accessors with safe defaults — so consumers stop re-deriving these.
function filesTouched(sidecar) {
  return Array.isArray(sidecar && sidecar.files_touched) ? sidecar.files_touched : [];
}
function activeWorktree(sidecar) { return String((sidecar && sidecar.active_worktree) || ''); }
function jiraTicket(sidecar) { return String((sidecar && sidecar.jira_ticket) || '').trim(); }
function project(sidecar) { return String((sidecar && sidecar.project) || '').trim(); }

/** All session ids that have a sidecar file. */
function listSessionIds(root) {
  try {
    return fs.readdirSync(sidecarDir(root))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch { return []; }
}

/** `{ id, sidecar }` for every readable sidecar (unparseable ones dropped). */
function readSessions(root) {
  return listSessionIds(root)
    .map((id) => ({ id, sidecar: readSidecar(root, id) }))
    .filter((s) => s.sidecar);
}

/**
 * Read the BMAD workflow session YAML (`.ai-session/by-id/<id>.yaml`) — distinct from
 * the JSON sidecar — and return the current phase/agent, or null if absent/unparseable.
 * Extraction session ids arrive as "conversation-<uuid>"; the leading prefix is stripped.
 *
 * @returns {{agent: string, phase: (number|null)}|null}
 */
function readWorkflowState(root, sessionId) {
  const id = String(sessionId || '').replace(/^conversation-/, '');
  if (!id) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(sidecarDir(root), `${id}.yaml`), 'utf8'); }
  catch { return null; }
  // Minimal, dependency-free read of the `current:` block's agent/phase (the file is
  // machine-written with a stable shape). Splitting on top-level keys scopes the match to
  // the current block; `agent:` is anchored so `agent_status:` never matches it.
  const block = raw.split(/\n(?=\S)/).find((b) => /^current:/.test(b));
  if (!block) return null;
  const am = block.match(/^\s+agent:\s*"?([^"\n]+?)"?\s*$/m);
  const pm = block.match(/^\s+phase:\s*(\d+)/m);
  return { agent: am ? am[1].trim() : '', phase: pm ? Number(pm[1]) : null };
}

/** Session-end events — delegates to the existing sharded-JSONL reader. */
function readSessionEnds(root) {
  try { return require('./session-events').readAllEvents(root, 'session_end'); }
  catch { return []; }
}

/**
 * Atomically read-modify-write a sidecar via the shared file lock. No-ops (returns
 * undefined, creates nothing) when the id is empty or the sidecar doesn't exist yet —
 * matching the "don't fabricate a sidecar" guard the write consumers hand-rolled. This
 * makes session-state the single owner of sidecar I/O (both read and write).
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {(s:object)=>object|undefined} mutate  return the next object, or undefined to skip the write
 * @returns {Promise<object|undefined>}
 */
async function updateSidecar(root, sessionId, mutate, opts) {
  if (!sessionId) return undefined;
  const p = sidecarPath(root, sessionId);
  if (!fs.existsSync(p)) return undefined;
  const { atomicUpdateJson } = require('./process');
  return atomicUpdateJson(p, mutate, opts);
}

module.exports = {
  sidecarDir, sidecarPath, readSidecar,
  filesTouched, activeWorktree, jiraTicket, project,
  listSessionIds, readSessions, readSessionEnds, updateSidecar, readWorkflowState,
};
