#!/usr/bin/env node
/**
 * inject-context.js — standalone wrapper for the UserPromptSubmit hook.
 *
 * The dispatcher (user-prompt-dispatcher.js, post-T8 refactor) calls
 * inject-context-impl.run() directly in-process. This wrapper exists for the
 * settings.json fallback path and for cross-OS smoke tests that exec the hook
 * directly. Reads stdin (fd 0 first, then /dev/stdin on POSIX) and prints the
 * impl's XML output.
 */

'use strict';

const fs = require('node:fs');
const { findWorkspaceRoot } = require('./_lib/workspace-root');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* fd 0 unreadable */ }
if (!raw) {
  try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch { /* not on Windows */ }
}

const out = require('./inject-context-impl').run({
  rawStdin: raw,
  workspaceRoot: findWorkspaceRoot(),
});
if (out) process.stdout.write(out);
process.exit(0);
