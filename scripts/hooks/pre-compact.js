'use strict';

// pre-compact.js — PreCompact hook for Claude Code.
// Saves a fresh-context snapshot BEFORE CC compacts the conversation, so
// context can be recovered if compaction loses important state.
// Fires on both manual (/compact) and auto (context-full) compaction.
// Always exits 0 with no stdout — never block compaction.

const fs = require('node:fs');
const { findWorkspaceRoot } = require('./_lib/workspace-root');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
if (!raw) {
  try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch {}
}

if (!raw) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

const sessionId = payload.session_id || '';
const trigger = payload.trigger || 'unknown';
if (!sessionId) process.exit(0);

try {
  require('../fresh-context-impl').run({
    sessionId,
    note: `pre-compact (${trigger}) — auto-saved before context compaction`,
    workspaceRoot: findWorkspaceRoot(),
  });
} catch {
  // fail-soft — never block compaction
}

process.exit(0);
