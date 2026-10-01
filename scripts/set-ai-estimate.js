#!/usr/bin/env node
'use strict';

// set-ai-estimate - Record an AI story-point estimate for a ticket.
// Usage: node scripts/set-ai-estimate.js --ticket PROJ-1234 --ai-sp 3 --basis create [--estimator <id>]
// Writes the Jira-free cache at .ai-memory/ai-estimates.json and mirrors ai_sp
// onto the per-session sidecar JSON that session-stop reads.
// See docs/specs/spec-2026-07-02-ai-ticket-estimation.md.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./_lib/process');
const { loadAiEstimates, saveAiEstimates } = require('./_lib/ai-estimates');
const { parseSimpleYaml } = require('./hooks/inject-context-impl');

const ROOT_DIR = process.env.AI_ESTIMATE_ROOT || path.dirname(__dirname);
const TICKET_RE = /^[A-Z]+-\d+$/;
const ALLOWED_SP = [0.5, 1, 2, 3, 5, 8, 13];
const ALLOWED_BASIS = ['create', 'post-plan'];

function parseArgs(argv) {
  const opts = { ticket: null, aiSp: null, basis: null, estimator: null };
  const flags = { '--ticket': 'ticket', '--ai-sp': 'aiSp', '--basis': 'basis', '--estimator': 'estimator' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    if (eq !== -1) {
      const field = flags[a.slice(0, eq)];
      if (field) opts[field] = a.slice(eq + 1);
    } else if (flags[a]) {
      opts[flags[a]] = argv[++i];
    }
  }
  return opts;
}

function die(msg) {
  process.stderr.write(`set-ai-estimate: ${msg}\n`);
  process.exit(1);
}

function resolveSessionId() {
  const fromEnv = process.env.CLAUDE_SESSION_ID;
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, '.ai-session', 'current.yaml'), 'utf8');
    return parseSimpleYaml(raw).claude_session_id || '';
  } catch { return ''; }
}

async function mirrorToSidecar(aiSp) {
  const sid = resolveSessionId();
  if (!sid) return;
  const sidecar = path.join(ROOT_DIR, '.ai-session', 'by-id', `${sid}.json`);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch { return; }
  obj.ai_estimated = aiSp;
  await atomicWrite(sidecar, JSON.stringify(obj, null, 2));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.ticket || !TICKET_RE.test(opts.ticket)) {
    die(`--ticket must match /^[A-Z]+-\\d+$/ (got ${JSON.stringify(opts.ticket)})`);
  }
  const aiSp = Number(opts.aiSp);
  if (opts.aiSp == null || !ALLOWED_SP.includes(aiSp)) {
    die(`--ai-sp must be one of ${ALLOWED_SP.join(', ')} (got ${JSON.stringify(opts.aiSp)})`);
  }
  if (!ALLOWED_BASIS.includes(opts.basis)) {
    die(`--basis must be one of ${ALLOWED_BASIS.join(', ')} (got ${JSON.stringify(opts.basis)})`);
  }

  const estimator = opts.estimator || process.env.CLAUDE_MODEL || 'unknown';
  const entry = { ai_sp: aiSp, basis: opts.basis, estimator, estimated_at: new Date().toISOString() };

  const cache = loadAiEstimates(ROOT_DIR);
  cache.entries[opts.ticket] = entry;
  await saveAiEstimates(ROOT_DIR, cache);

  await mirrorToSidecar(aiSp);
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
