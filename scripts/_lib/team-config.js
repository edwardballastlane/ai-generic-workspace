'use strict';

// Loads the team configuration the token dashboard needs (roster + pre-AI
// baselines) from one of two sources, in order:
//   1. .ai-memory/team-roster.json — committed, SALARY-FREE. The primary source
//      so CI and teammates get the roster: team-report.md contains compensation
//      and is gitignored (local-only), so it is absent everywhere but a dev's
//      machine. Since the dashboard no longer shows any money metric, only the
//      non-sensitive fields (name/role/allocation/session-username + baselines)
//      are needed, and this file carries exactly those.
//   2. .claude/commands/team-report.md — local fallback for authoring, parsed
//      the same way. Its salary columns are read but unused downstream.
//
// Returns { available, roster, monthly_cost_total, baseline, jira_aliases, reason }.
//   roster: [{ name, jira_name, session_username, role, allocation[, monthly_cost] }]
//   baseline: { be_sp_fte_mo, fe_sp_fte_mo }   (pre-AI SP/FTE/month)
// available=false (with a reason) when neither source is usable — callers
// degrade gracefully rather than rendering wrong numbers.

const fs = require('node:fs');
const path = require('node:path');

function teamReportPath(rootDir) {
  return path.join(rootDir, '.claude', 'commands', 'team-report.md');
}

function teamRosterPath(rootDir) {
  return path.join(rootDir, '.ai-memory', 'team-roster.json');
}

// Primary source: committed, salary-free roster JSON. Returns a full config
// object on success, or null when the file is absent/malformed (→ fall back to
// team-report.md). jira_aliases still comes from the separate team-aliases.json.
function loadRosterJson(rootDir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(teamRosterPath(rootDir), 'utf8')); }
  catch { return null; }
  const roster = Array.isArray(raw && raw.roster) ? raw.roster.filter(r =>
    r && r.jira_name && (r.role === 'BE' || r.role === 'FE') && isFinite(r.allocation)) : [];
  if (roster.length === 0) return null;
  const baseline = (raw && raw.baseline) || {};
  return {
    available: true,
    reason: 'roster-json',
    roster: roster.map(r => ({
      name: r.name || r.jira_name,
      jira_name: r.jira_name,
      session_username: r.session_username || '',
      role: r.role,
      allocation: Number(r.allocation),
    })),
    monthly_cost_total: null, // salary-free source; money metrics are not rendered
    baseline: {
      be_sp_fte_mo: baseline.be_sp_fte_mo != null ? Number(baseline.be_sp_fte_mo) : null,
      fe_sp_fte_mo: baseline.fe_sp_fte_mo != null ? Number(baseline.fe_sp_fte_mo) : null,
    },
    jira_aliases: loadTeamAliases(rootDir),
  };
}

function teamAliasesPath(rootDir) {
  return path.join(rootDir, '.ai-memory', 'team-aliases.json');
}

// { jiraDisplayNameVariant -> canonical roster jira_name }. Folds same-person
// Jira display-name variants (e.g. "jdoe" → "Jane Doe") onto the
// roster so their SP counts toward the right role. Absent file → empty map.
function loadTeamAliases(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(teamAliasesPath(rootDir), 'utf8'));
    return (raw && typeof raw.aliases === 'object' && raw.aliases) || {};
  } catch { return {}; }
}

// "| Jane | Jane Doe | jdoe | FE | Acme | 100% | $2,218 | $13 |"
function parseRosterRow(line) {
  const cells = line.split('|').map(c => c.trim());
  // Leading/trailing empty cells from the pipe delimiters → 10 cells for 8 cols.
  if (cells.length < 9) return null;
  const [, name, jiraName, sessionUser, role, , allocRaw, costRaw] = cells;
  const roleUp = (role || '').toUpperCase();
  if (roleUp !== 'BE' && roleUp !== 'FE') return null;
  const alloc = parseFloat(String(allocRaw).replace('%', ''));
  const cost = parseFloat(String(costRaw).replace(/[$,]/g, ''));
  if (!isFinite(alloc) || !isFinite(cost)) return null;
  // "—" (or blank) means the person has no recorded Claude Code session username.
  const su = (sessionUser && sessionUser !== '—') ? sessionUser : '';
  return {
    name,
    jira_name: jiraName,
    session_username: su,
    role: roleUp,
    allocation: alloc / 100,
    monthly_cost: cost,
  };
}

function loadTeamConfig(rootDir) {
  // Prefer the committed salary-free roster JSON (works in CI / for teammates);
  // fall back to parsing the local-only team-report.md.
  const fromJson = loadRosterJson(rootDir);
  if (fromJson) return fromJson;

  const file = teamReportPath(rootDir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { available: false, reason: 'team-report-missing' }; }

  const roster = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const row = parseRosterRow(line);
    if (row) roster.push(row);
  }
  if (roster.length === 0) return { available: false, reason: 'no-roster-rows' };

  // Prefer the explicit total line; fall back to summing the roster.
  const totalMatch = text.match(/Total monthly team cost:\s*\$([\d,]+)/i);
  const monthlyCostTotal = totalMatch
    ? parseFloat(totalMatch[1].replace(/,/g, ''))
    : roster.reduce((a, r) => a + r.monthly_cost, 0);

  // Pre-AI baselines: "... 8.7 SP/FTE/month" under the **Backend** section header,
  // "14.9 SP/FTE/month" under **Frontend**. Anchor on the bold `**` marker so a
  // roster jira-name containing the word "Frontend"/"Backend" can't hijack the match.
  const beMatch = text.match(/\*\*Backend[\s\S]*?([\d.]+)\s*SP\/FTE\/month/i);
  const feMatch = text.match(/\*\*Frontend[\s\S]*?([\d.]+)\s*SP\/FTE\/month/i);
  const baseline = {
    be_sp_fte_mo: beMatch ? parseFloat(beMatch[1]) : null,
    fe_sp_fte_mo: feMatch ? parseFloat(feMatch[1]) : null,
  };

  return {
    available: true,
    reason: 'ok',
    roster,
    monthly_cost_total: monthlyCostTotal,
    baseline,
    jira_aliases: loadTeamAliases(rootDir),
  };
}

module.exports = { loadTeamConfig, teamReportPath, teamRosterPath, teamAliasesPath, loadRosterJson, loadTeamAliases, parseRosterRow };
