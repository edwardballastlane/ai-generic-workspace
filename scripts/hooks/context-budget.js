#!/usr/bin/env node
/**
 * Context Budget — thin CLI shim.
 *
 * All logic lives in ./context-budget-impl.js. Kept for backwards
 * compatibility with direct invocation; the UserPromptSubmit dispatcher
 * calls the impl module in-process.
 */

'use strict';

const fs = require('fs');
const impl = require('./context-budget-impl');
const { findWorkspaceRoot } = require('./_lib/workspace-root');

let raw = '';
try { raw = fs.readFileSync('/dev/stdin', 'utf8'); }
catch { process.exit(0); }

let sessionId = '';
try {
  const parsed = JSON.parse(raw);
  sessionId = parsed.session_id || '';
} catch { /* non-JSON input is fine */ }

const output = impl.run({ sessionId, workspaceRoot: findWorkspaceRoot() });
if (output) process.stdout.write(output + '\n');
process.exit(0);
