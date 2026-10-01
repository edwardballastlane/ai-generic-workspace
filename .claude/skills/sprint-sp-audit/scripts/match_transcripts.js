#!/usr/bin/env node
'use strict';

/**
 * match_transcripts.js — find the Claude Code session that did a ticket's work by
 * grepping the local CC TRANSCRIPTS for signal terms, not the session-end attribution.
 *
 * Why this is the ground truth: the session-end log's `primary_jira_ticket` is derived
 * by commit-key heuristics and is (a) empty for unkeyed hotfixes, (b) single-valued even
 * though one long session routinely spans several tickets, and (c) date-collapsed by the
 * cumulative-snapshot dedup. So a ticket's real session can be invisible to match_sessions.js
 * yet sit plainly in the transcript — which records the branches pushed, commit subjects,
 * and files edited. Feed this the signal terms from the semantic PR match (branch names,
 * commit subjects, distinctive file paths or code strings) and it returns the sessions that
 * actually touched that work, with the in-transcript timestamp window.
 *
 * Note: CC stores transcripts per *project dir* (a hash of the cwd). Work done on a repo via
 * a workspace symlink is logged under the WORKSPACE project, not a repo-named one — so scan
 * all project dirs, don't assume a per-repo folder exists.
 *
 * Usage:
 *   node match_transcripts.js --term "company-fees-asset-id-type-mismatch" --term "String(fee.company.id)"
 *   node match_transcripts.js --term "networth-assets-excluded" --since 2026-06-01
 *   node match_transcripts.js --ticket PROJ-865 --term "..."   # --ticket just labels output
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const terms = [];
  let since = null, ticket = null, projectsDir = path.join(os.homedir(), '.claude', 'projects');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--term') terms.push(argv[++i]);
    else if (a === '--since') since = argv[++i];
    else if (a === '--ticket') ticket = argv[++i];
    else if (a === '--projects') projectsDir = argv[++i];
  }
  return { terms, since, ticket, projectsDir };
}

// Pull every "timestamp":"..." in a file cheaply, return [min,max] in the window.
function tsRange(file) {
  let min = null, max = null;
  const txt = fs.readFileSync(file, 'utf8');
  const re = /"timestamp":"(2\d{3}-\d{2}-\d{2}T[0-9:]+)/g;
  let m;
  while ((m = re.exec(txt))) {
    const t = m[1];
    if (!min || t < min) min = t;
    if (!max || t > max) max = t;
  }
  return { min, max, hasTerm: txt };
}

function main() {
  const { terms, since, ticket, projectsDir } = parseArgs(process.argv.slice(2));
  if (!terms.length) { console.error('provide at least one --term'); process.exit(1); }
  if (!fs.existsSync(projectsDir)) { console.error(`no projects dir at ${projectsDir}`); process.exit(1); }

  // Use ripgrep/grep to find candidate files fast, then refine in JS.
  const files = new Set();
  for (const term of terms) {
    try {
      const out = execFileSync('grep', ['-rlF', term, projectsDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      out.split('\n').filter((f) => f.endsWith('.jsonl')).forEach((f) => files.add(f));
    } catch { /* no matches for this term */ }
  }

  const results = [];
  for (const file of files) {
    const txt = fs.readFileSync(file, 'utf8');
    const matched = terms.filter((t) => txt.includes(t));
    if (!matched.length) continue;
    let min = null, max = null;
    const re = /"timestamp":"(2\d{3}-\d{2}-\d{2}T[0-9:]+)/g;
    let m;
    while ((m = re.exec(txt))) { const t = m[1]; if (!min || t < min) min = t; if (!max || t > max) max = t; }
    if (since && max && max < since) continue;
    results.push({
      session_id: path.basename(file, '.jsonl'),
      project: path.basename(path.dirname(file)).replace(/^-Users-[^-]+-/, ''),
      first_entry: min,
      last_entry: max,
      matched_terms: matched,
    });
  }
  results.sort((a, b) => (b.last_entry || '').localeCompare(a.last_entry || ''));

  process.stdout.write(JSON.stringify({ ticket: ticket || null, terms, sessions: results }, null, 2) + '\n');
}

main();
