#!/usr/bin/env node
/* eslint-disable no-empty */

// fresh-context.js — Thin CLI wrapper around fresh-context-impl.js.
//
// All snapshot-generation logic lives in scripts/fresh-context-impl.js so other
// Node hooks (pre-compact.js, T7) can invoke run() in-process. This wrapper
// owns argv parsing, stdin reading, the help message, and the terminal summary.
//
// Usage:
//   node ./scripts/fresh-context.js                    # save snapshot
//   node ./scripts/fresh-context.js "inline note"      # save with note
//   echo "stdin note" | node ./scripts/fresh-context.js
//   node ./scripts/fresh-context.js --print            # stdout only
//   node ./scripts/fresh-context.js --latest           # cat latest.md
//   node ./scripts/fresh-context.js --session-id <id>  # specific sidecar

'use strict';

const fs = require('node:fs');
const impl = require('./fresh-context-impl');

// AC-19: self-apply executable bit (mirrors bash original's `chmod +x`).
try { fs.chmodSync(__filename, 0o755); } catch {}

function parseArgs(argv) {
  const out = { mode: 'save', sessionId: '', note: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print') { out.mode = 'print'; continue; }
    if (a === '--latest') { out.mode = 'latest'; continue; }
    if (a === '--session-id') { out.sessionId = argv[++i] || ''; continue; }
    if (a === '-h' || a === '--help') { out.mode = 'help'; continue; }
    if (a.startsWith('-')) {
      process.stderr.write(`Unknown option: ${a}\n`);
      process.exit(1);
    }
    out.note = a;
  }
  return out;
}

function readStdinSync() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function fmtCost(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function colorPalette() {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return { R: '', DIM: '', BRAND: '', HEALTHY: '', MUTED: '' };
  }
  return {
    R: '\x1b[0m', DIM: '\x1b[2m',
    BRAND: '\x1b[38;2;249;115;22m',
    HEALTHY: '\x1b[38;2;16;185;129m',
    MUTED: '\x1b[38;2;136;136;136m'
  };
}

function printSummary({ filename, sidecar, git }) {
  const c = colorPalette();
  process.stdout.write(`${c.HEALTHY}✓ Snapshot saved${c.R} ${c.DIM}.ai-session/resume/${filename}${c.R}\n`);
  process.stdout.write(`  ${c.MUTED}Project:${c.R}  ${c.BRAND}${sidecar.project}${c.R}\n`);
  process.stdout.write(`  ${c.MUTED}Branch:${c.R}   ${git.branch} (${git.ahead} ahead)\n`);
  process.stdout.write(`  ${c.MUTED}Prompts:${c.R}  ${sidecar.prompts}\n`);
  if (sidecar.costUsd > 0) {
    process.stdout.write(`  ${c.MUTED}Cost:${c.R}     ${fmtCost(sidecar.costUsd)}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(`${c.DIM}To resume: open a new Claude Code session, then paste the contents of:${c.R}\n`);
  process.stdout.write(`  ${c.MUTED}.ai-session/resume/latest.md${c.R}\n`);
  process.stdout.write(`${c.DIM}Or:  cat .ai-session/resume/latest.md | pbcopy${c.R}\n`);
}

function printHelp() {
  const help = [
    'fresh-context.js — Save a paste-ready handoff prompt',
    '',
    'Usage:',
    '  node ./scripts/fresh-context.js',
    '  node ./scripts/fresh-context.js "inline note"',
    '  echo "note" | node ./scripts/fresh-context.js',
    '  node ./scripts/fresh-context.js --print',
    '  node ./scripts/fresh-context.js --latest',
    '  node ./scripts/fresh-context.js --session-id <id>',
    ''
  ].join('\n');
  process.stdout.write(help);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = process.cwd();

  if (args.mode === 'help') { printHelp(); return; }
  if (args.mode === 'latest') { impl.runLatest({ workspaceRoot }); return; }

  let note = args.note;
  if (!note) note = readStdinSync().trim();

  const result = impl.run({
    sessionId: args.sessionId,
    note,
    workspaceRoot,
    mode: args.mode === 'print' ? 'print' : 'save',
  });

  if (args.mode === 'print') {
    process.stdout.write(result.content + '\n');
    return;
  }

  printSummary(result);
}

main();
