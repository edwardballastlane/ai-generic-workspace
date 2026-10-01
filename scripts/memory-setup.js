#!/usr/bin/env node
'use strict';

/**
 * memory-setup — one-command onboarding for the lane-memory system.
 * Seeds the local store from the shared KBs and imports any teammate chunks, then
 * prints the single manual step (restart Claude Code so the MCP server loads).
 *
 * Usage: npm run memory:setup
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(label, args) {
  process.stdout.write(`\n• ${label}\n`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  return r.status === 0;
}

const scripts = path.join(__dirname);
run('Registering git merge drivers (union-merge for shared event logs)…', [path.join(scripts, 'setup-merge-drivers.js')]);
run('Seeding memory from the shared rules KB (idempotent)…', [path.join(scripts, 'memory-migrate.js')]);
run('Importing any teammate memory chunks…', [path.join(scripts, 'memory-export.js'), 'import']);

process.stdout.write([
  '',
  '✅ lane-memory store is seeded.',
  '',
  'One manual step (no install needed):',
  '  1. Restart Claude Code so it loads the "lane-memory" server from .mcp.json',
  '     (and approve the project MCP server if prompted).',
  '',
  'After that the agent can mem_search / mem_save live. Team sharing is automatic:',
  '  • your locally-authored observations auto-export on session end and push with the session log;',
  '  • teammates\' observations auto-import on session start after you pull.',
  '',
  'See docs/reference/memory-protocol.md for the tool + sharing details.',
  '',
].join('\n'));
