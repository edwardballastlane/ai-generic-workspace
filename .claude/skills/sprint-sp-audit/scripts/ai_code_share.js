#!/usr/bin/env node
'use strict';

/**
 * ai_code_share.js — % of shipped code written by AI, per ticket and blended.
 *
 * Joins two existing signals by Jira ticket key:
 *   - match_sessions.js  → AI-attributed lines (Claude Code's own Edit/Write tool stats,
 *     summed across every local session tagged with the ticket)
 *   - match_prs.js       → the REAL total lines changed, from Bitbucket's PR diffstat on
 *     the merged PR(s) for that ticket (i.e. what actually shows in the diff before merge)
 *
 * pct_ai_written = ai_lines / total_lines * 100
 *
 * This is deliberately PR-diff-based rather than a per-session git-diff heuristic: the PR
 * diffstat is the one number everyone already trusts (it's what reviewers see), so the %
 * is anchored to something real instead of a fragile session-window git snapshot.
 *
 * Known caveats (surfaced in output, not hidden):
 *   - Only tickets with at least one MERGED PR are counted. In-flight work is excluded.
 *   - AI lines only count Claude's Edit/Write tool calls (Claude Code's own tracking) —
 *     if Claude edits a file via Bash (sed/heredoc/etc.) those lines are NOT counted as AI,
 *     which underestimates the AI share.
 *   - ai_lines can exceed total_lines (Claude drafts/rewrites code that gets superseded
 *     within the same PR) — pct_ai_written can then read above 100; left unclamped so the
 *     anomaly is visible rather than silently hidden.
 *   - Only ~38% of local sessions tag a jira_ticket (measured tagging coverage),
 *     so ai_lines is a FLOOR, not an exact count — a ticket showing 0% AI may just mean no
 *     session tagged that ticket, not that no AI was used.
 *
 * Usage:
 *   node ai_code_share.js PROJ-865 PROJ-866 [...keys]   # explicit tickets
 *   node ai_code_share.js --all                            # every ticket with a local AI session
 *   node ai_code_share.js --all --user "Jane Doe"    # scope to one dev
 *   node ai_code_share.js --all --repos my-backend,my-portal-web
 *
 * Output: JSON to stdout — { tickets: [...], blended: {...} }
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = __dirname;

function parseArgs(argv) {
  const keys = [];
  let all = false;
  let user = null;
  let repos = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--user') user = argv[++i];
    else if (a === '--repos') repos = argv[++i];
    else if (!a.startsWith('--')) keys.push(a.toUpperCase());
  }
  return { keys, all, user, repos };
}

function runJson(script, args) {
  let out;
  try {
    out = execFileSync('node', [path.join(DIR, script), ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    const stderr = String(e.stderr || e.message || '');
    if (/ENOENT.*\.env|ATLASSIAN_(EMAIL|API_TOKEN)/.test(stderr)) {
      throw new Error(
        `${script} needs Atlassian/Bitbucket credentials (ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in .env). ` +
        `Run the setup-credentials skill, then retry.`
      );
    }
    throw new Error(`${script} failed: ${stderr.split('\n')[0]}`);
  }
  return JSON.parse(out);
}

function main() {
  const { keys, all, user, repos } = parseArgs(process.argv.slice(2));

  const sessionArgs = all ? ['--all'] : [...keys];
  if (user) sessionArgs.push('--user', user);
  const sessions = runJson('match_sessions.js', sessionArgs);

  const wanted = all ? Object.keys(sessions) : keys;
  if (!wanted.length) {
    process.stdout.write(JSON.stringify({ tickets: [], blended: null, note: 'no tickets to match' }, null, 2) + '\n');
    return;
  }

  const prArgs = [...wanted];
  if (user) prArgs.push('--author', user);
  if (repos) prArgs.push('--repos', repos);
  const prs = runJson('match_prs.js', prArgs);

  const tickets = [];
  const blended = { ai_lines: 0, total_lines: 0, tickets_matched: 0, tickets_skipped_no_pr: 0 };

  for (const ticket of wanted) {
    const s = sessions[ticket] || { lines_added: 0, lines_removed: 0, sessions: 0 };
    const p = prs[ticket] || { lines_added: 0, lines_removed: 0, pr_count: 0 };

    const aiLines = (s.lines_added || 0) + (s.lines_removed || 0);
    const totalLines = (p.lines_added || 0) + (p.lines_removed || 0);

    if (p.pr_count === 0) {
      blended.tickets_skipped_no_pr++;
      tickets.push({
        ticket,
        ai_lines: aiLines,
        total_lines: 0,
        pct_ai_written: null,
        pr_count: 0,
        ai_sessions: s.sessions || 0,
        note: 'no merged PR matched — excluded from blended %'
      });
      continue;
    }

    blended.ai_lines += aiLines;
    blended.total_lines += totalLines;
    blended.tickets_matched++;

    tickets.push({
      ticket,
      ai_lines: aiLines,
      total_lines: totalLines,
      pct_ai_written: totalLines ? Math.round((aiLines / totalLines) * 1000) / 10 : null,
      pr_count: p.pr_count,
      ai_sessions: s.sessions || 0
    });
  }

  blended.pct_ai_written = blended.total_lines
    ? Math.round((blended.ai_lines / blended.total_lines) * 1000) / 10
    : null;

  process.stdout.write(JSON.stringify({ tickets, blended }, null, 2) + '\n');
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
