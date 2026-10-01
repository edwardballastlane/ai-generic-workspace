/**
 * Workspace-root resolver — shared helper.
 *
 * CommonJS on purpose: plain-Node hook scripts (`*.js`) and ts-node-loaded
 * hook/CLI scripts (`*.ts`) can both consume it. TS files should use:
 *   const { findWorkspaceRoot } = require('./_lib/workspace-root');
 * or in ESM-style TS:
 *   import { findWorkspaceRoot } from './_lib/workspace-root';
 *
 * Resolution order:
 *   1. `WORKSPACE_ROOT` env var (explicit override for tests / scripts)
 *   2. Walk up from the caller's `__dirname` (or this file's dir) looking
 *      for a directory that contains `CLAUDE.md`. Cap at 15 ancestors so
 *      a runaway loop can't wedge a hook.
 *   3. Fallback to `process.cwd()`.
 *
 * Historical note: every hook / CLI used to inline its own copy of this
 * logic. Extracted to de-duplicate 7 call sites and close the drift gap
 * flagged in pre-push review.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function findWorkspaceRoot(startDir) {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = startDir || __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, 'CLAUDE.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

module.exports = { findWorkspaceRoot };
