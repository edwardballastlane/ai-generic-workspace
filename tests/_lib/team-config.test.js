'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTeamConfig, parseRosterRow, loadTeamAliases, loadRosterJson } = require('../../scripts/_lib/team-config');

function mkFixture(reportMd, aliasesJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cfg-'));
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'team-report.md'), reportMd);
  if (aliasesJson != null) fs.writeFileSync(path.join(dir, '.ai-memory', 'team-aliases.json'), aliasesJson);
  return dir;
}

// Entirely synthetic roster — fake names, fake salaries. No real teammate data.
const REPORT = [
  '## Configuration',
  '| Name | Jira Display Name | Session Username | Role | Provider | FTE Allocation | Monthly Cost | Hourly Rate |',
  '|------|------|------|------|------|------|------|------|',
  '| Ada | Ada Frontend | ada | FE | Acme | 100% | $1,000 | $10 |',
  '| Ben | Ben Backend | ben-cli | BE | Acme | 50% | $2,000 | $20 |',
  '| Cid | Cid Middle | — | BE | Acme | 100% | $3,000 | $30 |',
  '',
  '**Total monthly team cost: $6,000**',
  '',
  '**Backend (0.90 FTE avg per sprint):**',
  '- Monthly equivalent (×1.43): 5.8 tickets/FTE/month, 8.7 SP/FTE/month',
  '',
  '**Frontend (0.79 FTE avg per sprint):**',
  '- Monthly equivalent (×1.43): 14.1 tickets/FTE/month, 14.9 SP/FTE/month',
].join('\n');

test('parseRosterRow extracts name, jira name, session username, role, allocation, cost', () => {
  const row = parseRosterRow('| Ben | Ben Backend | ben-cli | BE | Acme | 50% | $2,000 | $20 |');
  assert.deepEqual(row, {
    name: 'Ben', jira_name: 'Ben Backend', session_username: 'ben-cli',
    role: 'BE', allocation: 0.5, monthly_cost: 2000,
  });
});

test('parseRosterRow treats "—" session username as empty', () => {
  const row = parseRosterRow('| Cid | Cid Middle | — | BE | Acme | 100% | $3,000 | $30 |');
  assert.equal(row.session_username, '');
});

test('parseRosterRow rejects the header and separator rows', () => {
  assert.equal(parseRosterRow('| Name | Jira Display Name | Session Username | Role | Provider | FTE Allocation | Monthly Cost | Hourly Rate |'), null);
  assert.equal(parseRosterRow('|------|------|------|------|------|------|------|------|'), null);
});

test('loadTeamConfig parses roster, total cost, and pre-AI baselines', () => {
  const dir = mkFixture(REPORT, null);
  const cfg = loadTeamConfig(dir);
  assert.equal(cfg.available, true);
  assert.equal(cfg.roster.length, 3);
  assert.equal(cfg.monthly_cost_total, 6000);
  assert.deepEqual(cfg.baseline, { be_sp_fte_mo: 8.7, fe_sp_fte_mo: 14.9 });
  const roles = cfg.roster.map(r => r.role).sort();
  assert.deepEqual(roles, ['BE', 'BE', 'FE']);
});

test('loadTeamConfig falls back to summing roster when total line is absent', () => {
  const dir = mkFixture(REPORT.replace('**Total monthly team cost: $6,000**', ''), null);
  const cfg = loadTeamConfig(dir);
  assert.equal(cfg.monthly_cost_total, 1000 + 2000 + 3000);
});

test('loadTeamConfig degrades gracefully when the file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cfg-empty-'));
  const cfg = loadTeamConfig(dir);
  assert.equal(cfg.available, false);
  assert.equal(cfg.reason, 'team-report-missing');
});

test('loadTeamAliases reads the alias map; empty when absent', () => {
  const withAliases = mkFixture(REPORT, JSON.stringify({ aliases: { 'ada2': 'Ada Frontend' } }));
  assert.deepEqual(loadTeamAliases(withAliases), { 'ada2': 'Ada Frontend' });
  const cfg = loadTeamConfig(withAliases);
  assert.deepEqual(cfg.jira_aliases, { 'ada2': 'Ada Frontend' });

  const noAliases = mkFixture(REPORT, null);
  assert.deepEqual(loadTeamAliases(noAliases), {});
});

test('team-roster.json (salary-free) is preferred over team-report.md and works without it', () => {
  // The CI-critical path: team-report.md is gitignored (compensation), so in CI
  // the roster must come from the committed salary-free JSON alone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-json-'));
  fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
  // NOTE: no team-report.md written — simulates CI where it's absent.
  fs.writeFileSync(path.join(dir, '.ai-memory', 'team-roster.json'), JSON.stringify({
    roster: [
      { name: 'Ada', jira_name: 'Ada Frontend', session_username: 'ada', role: 'FE', allocation: 1 },
      { name: 'Ben', jira_name: 'Ben Backend', session_username: 'ben', role: 'BE', allocation: 0.5 },
    ],
    baseline: { be_sp_fte_mo: 8.7, fe_sp_fte_mo: 14.9 },
  }));
  fs.writeFileSync(path.join(dir, '.ai-memory', 'team-aliases.json'), JSON.stringify({ aliases: { 'ada2': 'Ada Frontend' } }));
  const cfg = loadTeamConfig(dir);
  assert.equal(cfg.available, true);
  assert.equal(cfg.reason, 'roster-json');
  assert.equal(cfg.roster.length, 2);
  assert.equal(cfg.monthly_cost_total, null, 'salary-free source carries no cost');
  assert.deepEqual(cfg.baseline, { be_sp_fte_mo: 8.7, fe_sp_fte_mo: 14.9 });
  assert.equal(cfg.jira_aliases.ada2, 'Ada Frontend');
  assert.ok(cfg.roster.every(r => 'session_username' in r));
});

test('loadRosterJson returns null on missing/malformed JSON → falls back to team-report.md', () => {
  const dir = mkFixture(REPORT, null); // has team-report.md, no team-roster.json
  assert.equal(loadRosterJson(dir), null, 'no JSON → null');
  const cfg = loadTeamConfig(dir);
  assert.equal(cfg.reason, 'ok', 'falls back to md parse');
  assert.equal(cfg.monthly_cost_total, 6000);
  // Malformed JSON also falls through.
  fs.writeFileSync(path.join(dir, '.ai-memory', 'team-roster.json'), '{ not json');
  assert.equal(loadRosterJson(dir), null, 'malformed JSON → null');
});

test('the real workspace config still loads (guards parser + JSON against edits)', () => {
  // Structural-only assertions — never asserts real names/salaries, so this test
  // file stays free of teammate PII. Source may be the salary-free JSON (CI) or
  // team-report.md (local); either must yield a usable roster + baselines.
  const root = path.resolve(__dirname, '..', '..');
  const hasJson = fs.existsSync(path.join(root, '.ai-memory', 'team-roster.json'));
  const hasMd = fs.existsSync(path.join(root, '.claude', 'commands', 'team-report.md'));
  if (!hasJson && !hasMd) return; // skip if neither present
  const cfg = loadTeamConfig(root);
  assert.equal(cfg.available, true, 'roster config must remain loadable');
  assert.ok(cfg.roster.length >= 1);
  assert.ok(cfg.baseline.be_sp_fte_mo > 0 && cfg.baseline.fe_sp_fte_mo > 0);
  assert.ok(cfg.roster.every(r => 'session_username' in r));
});
