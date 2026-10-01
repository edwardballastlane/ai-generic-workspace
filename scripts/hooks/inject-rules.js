#!/usr/bin/env node
/**
 * Inject Rules — thin CLI shim.
 *
 * All logic lives in ./inject-rules-impl.js. This file exists so the existing
 * invocation path (`node scripts/hooks/inject-rules.js` with JSON on stdin)
 * keeps working after the UserPromptSubmit dispatcher consolidation.
 *
 * The dispatcher (scripts/hooks/user-prompt-dispatcher.js) calls the impl
 * module in-process to avoid a second Node startup per prompt.
 */

'use strict';

const fs = require('fs');
const impl = require('./inject-rules-impl');
const { findWorkspaceRoot } = require('./_lib/workspace-root');

let raw = '';
try { raw = fs.readFileSync('/dev/stdin', 'utf8'); }
catch { process.exit(0); }

let prompt = '';
let cwd = '';
let sessionId = '';
try {
  const parsed = JSON.parse(raw);
  prompt = parsed.prompt || '';
  cwd = parsed.cwd || '';
  sessionId = parsed.session_id || '';
} catch {
  prompt = raw;
}

const output = impl.run({ prompt, cwd, sessionId, workspaceRoot: findWorkspaceRoot() });
if (output) process.stdout.write(output + '\n');
process.exit(0);
