/**
 * detected-project cache — session-id-gated reader/writer.
 *
 * The `.ai-session/detected-project` file is a process-wide cache that
 * inject-context-impl and inject-rules-impl both consult to recover the
 * project name when no per-prompt signal (skill / cwd / prompt / yaml)
 * fires. Before this helper it was a single-line file shared across
 * parallel Claude Code sessions, which let terminal B's project leak into
 * terminal A's prompt-attribution path.
 *
 * The on-disk format is now two lines:
 *   <claude_session_id>\n
 *   <project-slug>\n
 *
 * read() returns the cached project ONLY when line 1 matches the caller's
 * session_id. Anything else (mismatch, malformed legacy 1-line file,
 * missing file, IO error) returns '' so the caller falls through to the
 * lower-priority detection sources.
 *
 * Linked plan: docs/specs/spec-2026-05-15-per-cc-session-binding.md
 * (Phase A — Touchpoints).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILENAME = 'detected-project';

function cachePath(workspaceRoot) {
  return path.join(workspaceRoot, '.ai-session', FILENAME);
}

function read(workspaceRoot, sessionId) {
  if (!sessionId) return '';
  let raw;
  try { raw = fs.readFileSync(cachePath(workspaceRoot), 'utf8'); }
  catch { return ''; }
  const lines = raw.split('\n');
  if (lines.length < 2) return '';
  const cachedSid = lines[0].trim();
  const cachedProject = lines[1].trim();
  if (!cachedSid || cachedSid !== sessionId) return '';
  return cachedProject;
}

function write(workspaceRoot, sessionId, project) {
  if (!sessionId || !project) return;
  const file = cachePath(workspaceRoot);
  // Sync mirror of scripts/_lib/process.js atomicWrite — temp-then-rename so a
  // parallel-session write can't expose a half-written file to a concurrent
  // reader. CLAUDE.md hook convention: "never write hook state with raw
  // fs.writeFileSync."
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${sessionId}\n${project}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* swallow */ }
  }
}

module.exports = { read, write, cachePath };
