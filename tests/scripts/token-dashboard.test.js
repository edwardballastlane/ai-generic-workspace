'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'token-dashboard.js');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'token-events-sample.jsonl');

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setupFixture(prefix) {
  const dir = await tmpDir(prefix);
  fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, '.ai-memory', 'session-end-events.jsonl'));
  return dir;
}

function runDashboard(root, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      JIRA_BASE_URL: 'https://test.atlassian.net',
      TOKEN_DASHBOARD_ROOT: root,
    },
  });
}

test('AC-8: default run produces both token-data.json and token-dashboard.html', async () => {
  const dir = await setupFixture('td-ac8-');
  try {
    const r = runDashboard(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
    const dataFile = path.join(dir, '.claude', 'visualizations', 'token-data.json');
    const htmlFile = path.join(dir, '.claude', 'visualizations', 'token-dashboard.html');
    assert.ok(fs.existsSync(dataFile), 'token-data.json should exist');
    assert.ok(fs.existsSync(htmlFile), 'token-dashboard.html should exist');
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(data.total.sessions, 4, 'expected 4 session_end events in fixture');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-9: --json-only writes JSON but NOT HTML', async () => {
  const dir = await setupFixture('td-ac9-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const dataFile = path.join(dir, '.claude', 'visualizations', 'token-data.json');
    const htmlFile = path.join(dir, '.claude', 'visualizations', 'token-dashboard.html');
    assert.ok(fs.existsSync(dataFile), 'token-data.json should exist');
    assert.ok(!fs.existsSync(htmlFile), 'token-dashboard.html must NOT exist with --json-only');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-10: leg-reset detection at 5% threshold sums per-leg max', async () => {
  // sess-compact-bbbb: cost 10 → 0.1 → 4.0. 0.1 < 10 * 0.05 = 0.5, so leg resets.
  // Per-leg max sum: max(10) + max(0.1, 4.0) = 10 + 4 = 14. Bob's session.
  const dir = await setupFixture('td-ac10-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const bob = data.by_user.find(u => u.user === 'bob@example.com');
    assert.ok(bob, 'bob should appear in by_user');
    assert.equal(bob.cost_usd, 14, 'sum-of-leg-max for bob = 10 + 4 = 14');
    // Also verify session aggregate (sess-compact-bbbb) sums per-leg max.
    const bobSession = data.sessions.find(s => s.session_id === 'sess-com');
    assert.ok(bobSession, 'sess-compact session in sessions list');
    assert.equal(bobSession.cost_usd, 14);
    assert.equal(bobSession.input_tokens, 28000, '20000 + 8000 = 28000 (per-leg max)');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-11: side-by-side equality vs frozen fixture totals', async () => {
  // The fixture's expected totals are the single source of truth: bash and node
  // were run side-by-side during port development and both produced these values.
  // If this assertion fails, either the fixture changed or the port regressed.
  const dir = await setupFixture('td-ac11-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    assert.equal(data.total.sessions, 4);
    assert.equal(data.total.cost_usd, 25.0);
    assert.equal(data.total.input_tokens, 53500);
    assert.equal(data.total.output_tokens, 22700);
    assert.equal(data.total.prompts, 26);
    assert.equal(data.total.cache_read, 11100);
    assert.equal(data.total.cache_create, 4550);
    assert.equal(data.total.lines_added, 242);
    assert.equal(data.total.lines_removed, 51);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-12: prompts attributed via session aggregate, NOT per-event delta', async () => {
  // sess-prompts-dddd has prompts: 4, 7, 9 (monotonic increase), cost: 3.0, 0.05, 1.5
  // (with leg-reset between events 1 and 2 because 0.05 < 3.0 * 0.05 = 0.15).
  //
  // If prompts WERE in DELTA_FIELDS, the leg-reset would zero prevPrompts and
  // event 2 would credit 7 prompts (delta from 0 to 7), event 3 would credit 2
  // (9-7), totaling 4+7+2 = 13 prompts. WRONG.
  //
  // With AC-12 attribution: prompts = max() across session events = 9.
  // Dan's user total prompts must be 9, not 13.
  const dir = await setupFixture('td-ac12-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const dan = data.by_user.find(u => u.user === 'dan@example.com');
    assert.ok(dan, 'dan should appear in by_user');
    assert.equal(dan.prompts, 9, 'AC-12: prompts=max(4,7,9)=9, NOT delta-summed (=13)');
    // Also check session aggregate
    const danSession = data.sessions.find(s => s.session_id === 'sess-pro');
    assert.equal(danSession.prompts, 9);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-13: multi-day session credits each day with that day\'s delta', async () => {
  // sess-multiday-cccc has events at 2026-05-03T22:00 (cost=2.0) and
  // 2026-05-04T01:00 (cost=5.0). Pre-fix bash bug credited the full $5 to 05-04.
  // Post-fix delta attribution: 05-03 gets cost=2 (delta 0→2), 05-04 gets cost=3
  // (delta 2→5). The Node port must preserve the fix.
  const dir = await setupFixture('td-ac13-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const may03 = data.daily.find(d => d.date === '2026-05-03');
    const may04 = data.daily.find(d => d.date === '2026-05-04');
    assert.ok(may03 && may04, 'both 05-03 and 05-04 must appear in daily');
    // 05-03 has just the multiday event delta (no other events on that day).
    assert.equal(may03.cost_usd, 2, '05-03 receives the first event delta (0→2)');
    // 05-04 has only the multiday session's second event (delta 2→5 = 3).
    assert.equal(may04.cost_usd, 3, '05-04 receives only the same-session delta (2→5 = 3), NOT full session total $5');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('multi-day session splits prompts and session count across each active day', async () => {
  // sess-multiday-cccc has events on 2026-05-03 (prompts=2) and 2026-05-04 (prompts=4).
  // Pre-fix bug: ALL 4 prompts and the entire session credited to 05-03 (first day).
  // Post-fix: 05-03 gets prompt delta 0→2 = 2, 05-04 gets 2→4 = 2. Each day shows
  // sessions=1 (the session was active on both). User-level prompts still equals
  // max(prompts) per session, preserving AC-12.
  const dir = await setupFixture('td-daily-split-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const may03 = data.daily.find(d => d.date === '2026-05-03');
    const may04 = data.daily.find(d => d.date === '2026-05-04');
    assert.ok(may03 && may04, 'both 05-03 and 05-04 must appear in daily');
    assert.equal(may03.prompts, 2, '05-03 receives prompt delta (0→2)');
    assert.equal(may04.prompts, 2, '05-04 receives prompt delta (2→4), NOT 0');
    assert.equal(may03.sessions, 1, '05-03 counts the multiday session as active');
    assert.equal(may04.sessions, 1, '05-04 counts the multiday session as active (NOT 0)');
    // User-level prompts must still equal max(prompts) per session (AC-12 invariant).
    const carol = data.by_user.find(u => u.user === 'carol@example.com');
    assert.equal(carol.prompts, 4, 'user-level prompts = max(2,4) = 4');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('sessions[].active_days exposes per-day deltas so client can credit each day under user/date filters', async () => {
  // The client-side aggregate() re-buckets sessions when a user filter is
  // applied. Pre-fix, each session carried a single first-event ts, so a
  // multi-day session collapsed onto its start date in the daily table even
  // when the user did heavy work later. active_days on each session is the
  // contract that lets the client iterate per-day deltas.
  const dir = await setupFixture('td-active-days-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const multi = data.sessions.find(s => s.session_id === 'sess-mul');
    assert.ok(multi, 'sess-multiday-cccc must appear in sessions list');
    assert.ok(Array.isArray(multi.active_days), 'session must carry active_days');
    assert.equal(multi.active_days.length, 2, 'multi-day session has exactly 2 active days');
    const day03 = multi.active_days.find(d => d.date === '2026-05-03');
    const day04 = multi.active_days.find(d => d.date === '2026-05-04');
    assert.ok(day03 && day04, 'both active days emitted');
    assert.equal(day03.prompts, 2, '05-03 prompt delta on the session');
    assert.equal(day04.prompts, 2, '05-04 prompt delta on the session');
    assert.equal(day03.cost_usd, 2, '05-03 cost delta on the session');
    assert.equal(day04.cost_usd, 3, '05-04 cost delta on the session');
    // Single-day sessions still ship active_days (length 1) so the client can
    // iterate uniformly without a null check.
    const singleDay = data.sessions.find(s => s.session_id !== 'sess-mul');
    assert.ok(Array.isArray(singleDay.active_days), 'single-day sessions carry active_days too');
    assert.ok(singleDay.active_days.length >= 1, 'at least one active day');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('daily row exposes interactive_sessions / auxiliary_sessions split', async () => {
  // The client previously had to recompute this split because the server only
  // emitted total sessions per day. With active_days credit on the server,
  // the daily array now ships the split directly — kept available for clients
  // that prefer to trust the pre-computed value.
  const dir = await setupFixture('td-int-aux-');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    for (const d of data.daily) {
      const split = (d.interactive_sessions || 0) + (d.auxiliary_sessions || 0);
      assert.equal(split, d.sessions, `daily ${d.date}: interactive+auxiliary must equal total sessions`);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('cost leg-reset does NOT zero prompt-delta tracking (AC-12 monotonicity)', async () => {
  // Mid-session cost leg-reset (e.g. /clear) zeros the cost maxVals so cost
  // deltas restart from 0. But prompts is monotonic and must NOT reset, or
  // we'd double-count: a session ending at prompts=10 across a leg-reset
  // should still sum to 10 daily prompts, not 10 + post-reset value.
  const dir = await tmpDir('td-legreset-prompts-');
  fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
  // sess-X: cost 10 → 0.1 (leg-reset triggered, 0.1 < 10 * 0.05) → 4.0.
  // Prompts climb monotonically: 5 → 7 → 10.
  const events = [
    { type: 'session_end', session_id: 'sess-X', ts: '2026-05-20T10:00:00Z',
      user: 'u@e', project: 'p', cost_usd: 10.0, input_tokens: 100, prompts: 5 },
    { type: 'session_end', session_id: 'sess-X', ts: '2026-05-20T10:30:00Z',
      user: 'u@e', project: 'p', cost_usd: 0.1, input_tokens: 10, prompts: 7 },
    { type: 'session_end', session_id: 'sess-X', ts: '2026-05-20T11:00:00Z',
      user: 'u@e', project: 'p', cost_usd: 4.0, input_tokens: 50, prompts: 10 }
  ];
  fs.writeFileSync(path.join(dir, '.ai-memory', 'session-end-events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + '\n');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const data = JSON.parse(fs.readFileSync(
      path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const user = data.by_user.find(u => u.user === 'u@e');
    const day = data.daily.find(d => d.date === '2026-05-20');
    // If prompt-delta erroneously reset with cost, daily prompts would be 5+7+3=15.
    // Correct: deltas are 5, 2, 3 → sum = 10 (= final max).
    assert.equal(day.prompts, 10, 'daily prompts must NOT double-count across cost leg-reset');
    assert.equal(user.prompts, 10, 'user prompts must equal max(prompts) per AC-12');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-14: HTML structural assertions — JSON data block, expected section ids, escapes user content', async () => {
  // The dashboard does not use Chart.js — bash uses HTML/CSS bars (not <canvas>).
  // Structural checks: data block injected; expected DOM ids present; Jira URL escaped.
  const dir = await setupFixture('td-ac14-');
  try {
    const r = runDashboard(dir);
    assert.equal(r.status, 0);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');
    // Inline data block — JSON must round-trip
    const m = html.match(/const raw = (\{[\s\S]*?\n\});\s*\nconst JIRA_BASE_URL/);
    assert.ok(m, 'inline JSON data block (`const raw = { ... };`) must be present');
    const inline = JSON.parse(m[1]);
    assert.equal(inline.total.sessions, 4);
    // Expected section ids and table ids per the bash heredoc
    for (const id of ['section-daily', 'section-users', 'section-projects', 'section-tickets', 'section-sessions',
                      'daily-table', 'user-table', 'project-table', 'ticket-table', 'session-table']) {
      assert.ok(html.includes(`id="${id}"`), `expected id="${id}" in dashboard HTML`);
    }
    // Jira URL JS-encoded as a string literal
    assert.ok(html.includes('"https://test.atlassian.net"'), 'JIRA_BASE_URL must be JS-string-literal-encoded');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('embedded _lib modules share the SAME <script> block as `const raw` (deployed-IIFE guard)', async () => {
  // scripts/combine-dashboards.js wraps EACH <script> in its own IIFE for the
  // deployed index.html. If the embedded delivery-metrics/team-identity modules
  // live in a SEPARATE <script>, their functions are trapped in another IIFE and
  // the main render() throws "buildTeamIdentity is not defined" → blank dashboard.
  // Guard the invariant: the block defining `const raw` must also define them.
  const dir = await setupFixture('td-iife-');
  try {
    const r = runDashboard(dir);
    assert.equal(r.status, 0);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const rawBlock = blocks.find(b => /const raw = \{/.test(b));
    assert.ok(rawBlock, 'a <script> block defining `const raw` must exist');
    assert.ok(/function buildTeamIdentity\b/.test(rawBlock),
      'buildTeamIdentity must be defined in the SAME <script> as `const raw`');
    assert.ok(/function computeDeliveryMetrics\b/.test(rawBlock),
      'computeDeliveryMetrics must be defined in the SAME <script> as `const raw`');
    // And it must NOT live in any OTHER block (which would re-introduce the bug).
    const otherHasIt = blocks.some(b => b !== rawBlock && /function buildTeamIdentity\b/.test(b));
    assert.ok(!otherHasIt, 'embedded modules must not be in a separate <script> block');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('relative date windows anchor on raw.generated_at, not the browser clock', async () => {
  // A static dashboard is opened days/weeks after it was generated. If the client
  // anchors "Last 7d"/MTD/YTD on `new Date()` (wall clock at open-time), the windows
  // drift past the newest data and the default view renders empty — reads as "filters
  // broken". The relative anchor MUST be the snapshot's generated_at.
  const dir = await setupFixture('td-anchor-');
  try {
    const r = runDashboard(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');
    assert.ok(html.includes('const now = new Date(raw.generated_at)'),
      'relative-window anchor must derive `now` from raw.generated_at');
    assert.ok(!/const now = new Date\(\);/.test(html),
      'client `now` must not be anchored on the wall clock (new Date())');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('empty filter result resets every view to a uniform empty state', async () => {
  // When a filter combination yields zero sessions, all views must clear to the
  // same "No data for selected period" notice — including the summary cards (no
  // wall of zeros) and the session table (no headers-only blank).
  const dir = await setupFixture('td-empty-');
  try {
    const r = runDashboard(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');
    // Summary cards swap to a notice instead of rendering zero-value cards.
    assert.ok(/filtered\.length === 0[\s\S]{0,80}empty-msg">No data for selected period/.test(html),
      'summary cards must show an empty notice when the filter result is empty');
    // Session table gains an empty-row branch (it previously left a blank tbody).
    assert.ok(html.includes('colspan="13" class="empty-msg">No data for selected period'),
      'session table must render an empty-state row when no sessions match');
    // No view should keep the bare "No data" wording — uniform message everywhere.
    assert.ok(!/empty-msg">No data<\/td>/.test(html),
      'all empty-state messages must use the uniform "No data for selected period" text');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('caps per-row cost delta at MAX_ROW_DELTA_USD ($50) — protects against resume-jump artifacts', async () => {
  // Real-world scenario: `claude --print --resume <sid>` invocations during recap
  // backfill cause cumulative session cost_usd to JUMP by hundreds of dollars in a
  // single row. The leg-reset detector sees monotonic growth (no reset triggered),
  // so without the cap the entire jump would be attributed to today's spend.
  // The cap clamps these artifacts to $50 while leaving real session deltas alone.
  const dir = await tmpDir('td-cap-');
  fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
  // Two events for the same session: first $1, second $200 (a resume-jump).
  // True delta would be $199 → capped to $50.
  const events = [
    { type: 'session_end', session_id: 'sess-jump-eeee', ts: '2026-05-10T10:00:00Z',
      user: 'eve@example.com', project: 'epsilon', task: 'real interactive turn',
      cost_usd: 1.00, input_tokens: 1000, output_tokens: 500,
      cache_read_tokens: 200, cache_creation_tokens: 100, prompts: 1,
      duration_ms: 60000, lines_added: 1, lines_removed: 0 },
    { type: 'session_end', session_id: 'sess-jump-eeee', ts: '2026-05-10T11:00:00Z',
      user: 'eve@example.com', project: 'epsilon', task: 'real interactive turn',
      cost_usd: 200.00, input_tokens: 2000, output_tokens: 1000,
      cache_read_tokens: 500, cache_creation_tokens: 200, prompts: 2,
      duration_ms: 120000, lines_added: 2, lines_removed: 0 }
  ];
  fs.writeFileSync(path.join(dir, '.ai-memory', 'session-end-events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + '\n');
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const data = JSON.parse(fs.readFileSync(
      path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const eve = data.by_user.find(u => u.user === 'eve@example.com');
    assert.ok(eve, 'eve must appear in by_user');
    // Without cap: delta sum = 1 + 199 = 200. With $50 cap: 1 + 50 = 51.
    assert.equal(eve.cost_usd, 51,
      `expected delta-cap to clamp $199 jump to $50 (sum 1+50=51); got ${eve.cost_usd}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('per-tier calibration: premium users use premium_ratio, others use standard_ratio', async () => {
  // Two users in the fixture — bob (Premium per config) and dan (Standard).
  // bob's list-price total should be multiplied by 0.71; dan's by 0.24.
  const dir = await setupFixture('td-tiers-');
  fs.writeFileSync(path.join(dir, '.ai-memory', 'calibration-tiers.json'), JSON.stringify({
    premium_ratio: 0.71,
    standard_ratio: 0.24,
    premium_users: ['bob@example.com']
  }));
  try {
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const data = JSON.parse(fs.readFileSync(
      path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const bob = data.by_user.find(u => u.user === 'bob@example.com');
    const dan = data.by_user.find(u => u.user === 'dan@example.com');
    assert.ok(bob && dan, 'bob and dan must both appear');
    assert.equal(bob.calibration_ratio, 0.71, 'bob is in premium_users');
    assert.equal(dan.calibration_ratio, 0.24, 'dan defaults to standard');
    assert.equal(bob.cost_billed_usd, Math.round(bob.cost_usd * 0.71 * 100) / 100);
    assert.equal(dan.cost_billed_usd, Math.round(dan.cost_usd * 0.24 * 100) / 100);
    // Total cost_billed_usd is sum of per-user calibrated costs (NOT total × one ratio)
    const expectedTotal = data.by_user.reduce((acc, u) => acc + u.cost_billed_usd, 0);
    assert.ok(Math.abs(data.total.cost_billed_usd - Math.round(expectedTotal * 100) / 100) < 0.01,
      `total billed should be sum of per-user; expected ~${expectedTotal}, got ${data.total.cost_billed_usd}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('BILLING_CALIBRATION env var is propagated into the JSON payload', async () => {
  // The HTML reads `raw.billing_calibration` to render the "Billed (est.)" KPI
  // card; tests verify the field is present and reflects the env var. Default
  // (no env var) yields 1.0; setting BILLING_CALIBRATION=0.69 yields 0.69.
  const dirDefault = await setupFixture('td-cal-default-');
  try {
    const r1 = spawnSync(process.execPath, [SCRIPT, '--json-only'], {
      encoding: 'utf8',
      env: { ...process.env, JIRA_BASE_URL: 'https://test.atlassian.net',
        TOKEN_DASHBOARD_ROOT: dirDefault, BILLING_CALIBRATION: '' },
    });
    assert.equal(r1.status, 0, `exit ${r1.status}\nstderr=${r1.stderr}`);
    const data1 = JSON.parse(fs.readFileSync(
      path.join(dirDefault, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    assert.equal(data1.billing_calibration, 1.0, 'default calibration is 1.0');
  } finally {
    await fsp.rm(dirDefault, { recursive: true, force: true });
  }

  const dirSet = await setupFixture('td-cal-set-');
  try {
    const r2 = spawnSync(process.execPath, [SCRIPT, '--json-only'], {
      encoding: 'utf8',
      env: { ...process.env, JIRA_BASE_URL: 'https://test.atlassian.net',
        TOKEN_DASHBOARD_ROOT: dirSet, BILLING_CALIBRATION: '0.69' },
    });
    assert.equal(r2.status, 0, `exit ${r2.status}\nstderr=${r2.stderr}`);
    const data2 = JSON.parse(fs.readFileSync(
      path.join(dirSet, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    assert.equal(data2.billing_calibration, 0.69);
  } finally {
    await fsp.rm(dirSet, { recursive: true, force: true });
  }
});

test('AC-15: dashboard generation does not invoke python3', async () => {
  // Read the JS source and verify no python invocation substring slipped in.
  // Reviewer-grade sanity gate for AC-15: dashboard must be 100% Node.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // Documentation comments may mention "Python" — check only for invocation patterns.
  const callPatterns = [
    /\bspawn(?:Sync)?\s*\(\s*['"]python/,
    /\bexecFile(?:Sync)?\s*\(\s*['"]python/,
    /\bexecSync\s*\(\s*['"][^'"]*python/,
  ];
  for (const p of callPatterns) {
    assert.ok(!p.test(src), `token-dashboard.js must not invoke python (matched: ${p})`);
  }
});

test('exits non-zero with a helpful message when events file is missing', async () => {
  const dir = await tmpDir('td-noevents-');
  try {
    // No .ai-memory at all
    const r = runDashboard(dir);
    assert.notEqual(r.status, 0, 'should exit non-zero when events file is missing');
    assert.match(r.stdout + r.stderr, /No session events found/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('skips malformed JSONL lines and non-session_end event types', async () => {
  // Belt-and-suspenders: the fixture already includes a non-session_end (session_start)
  // line, but also test malformed JSON tolerance directly.
  const dir = await tmpDir('td-malformed-');
  try {
    fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
    const events = [
      JSON.stringify({ type: 'session_end', session_id: 's1', ts: '2026-05-01T10:00:00Z', user: 'u', project: 'p', cost_usd: 1.0, input_tokens: 100, prompts: 1 }),
      'not-json{garbage',
      '',
      JSON.stringify({ type: 'session_start', session_id: 's2', ts: '2026-05-01T11:00:00Z' }),
      JSON.stringify({ type: 'session_end', session_id: 's3', ts: '2026-05-02T10:00:00Z', user: 'u', project: 'p', cost_usd: 2.0, input_tokens: 200, prompts: 2 }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, '.ai-memory', 'session-end-events.jsonl'), events);
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    assert.equal(data.total.sessions, 2, 'should ignore malformed lines and non-session_end events');
    assert.equal(data.total.cost_usd, 3.0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('user-aliases.json folds git-name variants onto one canonical user', async () => {
  const dir = await tmpDir('td-aliases-');
  try {
    fs.mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
    const events = [
      JSON.stringify({ type: 'session_end', session_id: 's1', ts: '2026-06-01T10:00:00Z', user: 'jdoe91', project: 'p', cost_usd: 1.0, input_tokens: 100, prompts: 1 }),
      JSON.stringify({ type: 'session_end', session_id: 's2', ts: '2026-06-02T10:00:00Z', user: 'Jane Doe', project: 'p', cost_usd: 2.0, input_tokens: 200, prompts: 2 }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, '.ai-memory', 'session-end-events.jsonl'), events);
    fs.writeFileSync(
      path.join(dir, '.ai-memory', 'user-aliases.json'),
      JSON.stringify({ aliases: { jdoe91: 'Jane Doe' } })
    );
    const r = runDashboard(dir, ['--json-only']);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const users = data.by_user.map(u => u.user);
    assert.ok(!users.includes('jdoe91'), 'variant should be folded away');
    const maur = data.by_user.filter(u => u.user === 'Jane Doe');
    assert.equal(maur.length, 1, 'both sessions credited to one canonical user');
    assert.equal(maur[0].sessions, 2);
    assert.equal(maur[0].cost_usd, 3.0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── AI ticket estimation (spec-2026-07-02-ai-ticket-estimation.md, T-8) ────
//
// The ticket-table "AI Est" cell, the AI-sizing accuracy tile, and the
// By-User "AI-SP / 1M tokens" cell are all computed CLIENT-SIDE inside the
// emitted <script> block (raw.ai_estimates + raw.story_points feed pure JS
// functions like computeAiAccuracy()/aiSpCreditedByUser()). This suite has
// no jsdom/browser runner, so rather than re-deriving the formulas by hand
// we regex-extract the real shipped function source out of the generated
// HTML and execute it with `new Function(...)` — this exercises the exact
// code the browser would run (and would catch a real regression), without
// pulling in a DOM dependency. Non-DOM helpers (scaleIndex, computeAiAccuracy,
// aiSpCreditedByUser, pickCreditUser, ticketKeyOf, activeDaysInRange) need no
// stubbing; renderAiAccuracy() only touches document.getElementById, which we
// stub with a plain object collector.

function extractSource(html, re) {
  const m = html.match(re);
  assert.ok(m, `expected token-dashboard.js client script to contain a match for ${re}`);
  return m[0];
}

function extractInlineData(html) {
  const m = html.match(/const raw = (\{[\s\S]*?\n\});\s*\nconst JIRA_BASE_URL/);
  assert.ok(m, 'inline JSON data block (`const raw = { ... };`) must be present');
  return JSON.parse(m[1]);
}

// Runs the real, shipped computeAiAccuracy() (+ its pure deps) against `rawData`.
function runClientComputeAiAccuracy(html, rawData) {
  const scaleDecl = extractSource(html, /const AI_SP_SCALE = \[[^\]]*\];/);
  const scaleIndexFn = extractSource(html, /function scaleIndex\(v\) \{[\s\S]*?\n\}\n/);
  const computeFn = extractSource(html, /function computeAiAccuracy\(\) \{[\s\S]*?\n\}\n/);
  const fn = new Function('raw', `${scaleDecl}\n${scaleIndexFn}\n${computeFn}\nreturn computeAiAccuracy();`);
  return fn(rawData);
}

// Runs the real, shipped renderAiAccuracy() (+ its pure deps) against a
// minimal document stub, returning the innerHTML it set on #ai-accuracy-cards
// — i.e. exactly what the browser would render, including the
// "insufficient data" branch.
function runClientRenderAiAccuracy(html, rawData) {
  const scaleDecl = extractSource(html, /const AI_SP_SCALE = \[[^\]]*\];/);
  const scaleIndexFn = extractSource(html, /function scaleIndex\(v\) \{[\s\S]*?\n\}\n/);
  const escapeHtmlFn = extractSource(html, /function escapeHtml\([^)]*\) \{[\s\S]*?\n\}\n/);
  const computeFn = extractSource(html, /function computeAiAccuracy\(\) \{[\s\S]*?\n\}\n/);
  const renderFn = extractSource(html, /function renderAiAccuracy\(\) \{[\s\S]*?\n\}\n/);
  const els = {};
  const doc = {
    getElementById(id) {
      if (!els[id]) els[id] = { id, textContent: '', innerHTML: '' };
      return els[id];
    },
  };
  const fn = new Function('raw', 'document',
    `${scaleDecl}\n${scaleIndexFn}\n${escapeHtmlFn}\n${computeFn}\n${renderFn}\nrenderAiAccuracy();`);
  fn(rawData, doc);
  return els['ai-accuracy-cards'].innerHTML;
}

// Runs the real, shipped aiSpCreditedByUser() (+ its pure deps: pickCreditUser,
// ticketKeyOf, activeDaysInRange, TICKET_KEY_RE) against a sessions array.
function runClientAiSpCreditedByUser(html, rawData, sessions, from, to) {
  const ticketKeyRe = extractSource(html, /const TICKET_KEY_RE = [^;]+;/);
  const ticketKeyOfFn = extractSource(html, /function ticketKeyOf\(s\) \{[\s\S]*?\n\}\n/);
  const pickCreditUserFn = extractSource(html, /function pickCreditUser\([\s\S]*?\n\}\n/);
  const activeDaysInRangeFn = extractSource(html, /function activeDaysInRange\([\s\S]*?\n\}\n/);
  const aiSpCreditedByUserFn = extractSource(html, /function aiSpCreditedByUser\([\s\S]*?\n\}\n/);
  const fn = new Function('raw', 'sessions', 'from', 'to',
    `${ticketKeyRe}\n${ticketKeyOfFn}\n${pickCreditUserFn}\n${activeDaysInRangeFn}\n${aiSpCreditedByUserFn}\nreturn aiSpCreditedByUser(sessions, from, to);`);
  return fn(rawData, sessions, from, to);
}

test('AC-24: "By Jira Ticket" table renders an AI Est column — ai_sp for seeded tickets, — otherwise', async () => {
  const dir = await setupFixture('td-ac24-');
  try {
    // Fixture carries PROJ-100, PROJ-200, PROJ-300. Seed AI estimates for two of
    // them; PROJ-200 is deliberately left unestimated to exercise the dash path.
    fs.writeFileSync(path.join(dir, '.ai-memory', 'ai-estimates.json'), JSON.stringify({
      entries: {
        'PROJ-100': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-300': { ai_sp: 5, basis: 'post-plan', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
      },
    }));
    const r = runDashboard(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');

    // Header: "AI Est" <th> immediately follows the "SP" <th> in the ticket table.
    assert.ok(html.includes(
      'SP<span class="info">i</span></th><th title="The AI\'s own independent story-point estimate for this ticket (from .ai-memory/ai-estimates.json, set by scripts/set-ai-estimate.js). Never written to Jira. Dash = no AI estimate recorded.">AI Est<span class="info">i</span></th>'
    ), 'AI Est <th> must immediately follow the SP <th> in the ticket table header, with its own tooltip');

    // Data plumbing feeding the client render: seeded tickets carry ai_sp;
    // PROJ-200 (present in the fixture, no seeded estimate) is absent so the
    // client's `aiMeta.ai_sp == null` guard renders the em dash.
    const inline = extractInlineData(html);
    assert.equal(inline.ai_estimates.byTicket['PROJ-100'].ai_sp, 3);
    assert.equal(inline.ai_estimates.byTicket['PROJ-300'].ai_sp, 5);
    assert.ok(!inline.ai_estimates.byTicket['PROJ-200'], 'PROJ-200 must have no seeded AI estimate');
    assert.ok(html.includes('aiMeta.ai_sp == null'), 'client render must still guard for a missing AI estimate (dash path)');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-25: AI-sizing accuracy tile computes MAE, hit rate, and n over the comparable subset', async () => {
  const dir = await setupFixture('td-ac25-');
  try {
    // 5 tickets carrying both a human SP and an AI SP (>= the default
    // AI_ACCURACY_MIN_SAMPLE=2). Hand-computed expectations:
    //   PROJ-500: human=3,  ai=3  -> |err|=0, same scale index      -> hit
    //   PROJ-501: human=5,  ai=5  -> |err|=0, same scale index      -> hit
    //   PROJ-502: human=2,  ai=3  -> |err|=1, adjacent scale index  -> hit
    //   PROJ-503: human=8,  ai=13 -> |err|=5, adjacent scale index  -> hit
    //   PROJ-504: human=1,  ai=8  -> |err|=7, 4 scale steps apart   -> miss
    // MAE = (0+0+1+5+7)/5 = 2.6, hit rate = 4/5 = 0.8, n = 5.
    fs.writeFileSync(path.join(dir, '.ai-memory', 'jira-story-points.json'), JSON.stringify({
      detected_field: 'customfield_10038',
      cloud_id: 'test-cloud',
      entries: {
        'PROJ-500': { sp: 3, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-501': { sp: 5, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-502': { sp: 2, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-503': { sp: 8, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-504': { sp: 1, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
      },
    }));
    fs.writeFileSync(path.join(dir, '.ai-memory', 'ai-estimates.json'), JSON.stringify({
      entries: {
        'PROJ-500': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-501': { ai_sp: 5, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-502': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-503': { ai_sp: 13, basis: 'post-plan', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-504': { ai_sp: 8, basis: 'post-plan', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
      },
    }));
    const r = runDashboard(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');
    const inline = extractInlineData(html);
    assert.equal(inline.ai_estimates.minSample, 2, 'default AI_ACCURACY_MIN_SAMPLE is 2');

    const result = runClientComputeAiAccuracy(html, inline);
    assert.equal(result.n, 5, 'n must count only tickets with both a human SP > 0 and an AI SP > 0');
    assert.equal(result.mae, 2.6, 'MAE = mean(|ai_sp - human_sp|) over the comparable subset');
    assert.equal(result.hitRate, 0.8, 'hit rate = fraction within one scale-step');

    const rendered = runClientRenderAiAccuracy(html, inline);
    assert.ok(rendered.includes('>MAE<') && rendered.includes('>2.60<'), 'tile must render the MAE card with the computed value');
    assert.ok(rendered.includes('>Hit Rate<') && rendered.includes('>80%<'), 'tile must render the Hit Rate card with the computed value');
    assert.ok(rendered.includes('>Sample<') && rendered.includes('>5<'), 'tile must render the sample-count card');
    assert.ok(!rendered.includes('Insufficient data'), 'tile must NOT render "insufficient data" once the sample meets the threshold');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-26: below AI_ACCURACY_MIN_SAMPLE, the accuracy tile renders "insufficient data" instead of computed numbers', async () => {
  const dir = await setupFixture('td-ac26-');
  try {
    // Same 5 comparable tickets as AC-25 (n=5), but raise the env-overridable
    // threshold above the sample size so the tile must fall back.
    fs.writeFileSync(path.join(dir, '.ai-memory', 'jira-story-points.json'), JSON.stringify({
      detected_field: 'customfield_10038',
      cloud_id: 'test-cloud',
      entries: {
        'PROJ-500': { sp: 3, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-501': { sp: 5, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-502': { sp: 2, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-503': { sp: 8, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-504': { sp: 1, assignee: null, cached_at: '2026-07-01T00:00:00.000Z' },
      },
    }));
    fs.writeFileSync(path.join(dir, '.ai-memory', 'ai-estimates.json'), JSON.stringify({
      entries: {
        'PROJ-500': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-501': { ai_sp: 5, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-502': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-503': { ai_sp: 13, basis: 'post-plan', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
        'PROJ-504': { ai_sp: 8, basis: 'post-plan', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
      },
    }));
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://test.atlassian.net',
        TOKEN_DASHBOARD_ROOT: dir,
        AI_ACCURACY_MIN_SAMPLE: '10',
      },
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');
    const inline = extractInlineData(html);
    assert.equal(inline.ai_estimates.minSample, 10, 'AI_ACCURACY_MIN_SAMPLE env override must propagate into the payload');

    const result = runClientComputeAiAccuracy(html, inline);
    assert.equal(result.n, 5, 'the comparable count itself is unaffected by the threshold');

    const rendered = runClientRenderAiAccuracy(html, inline);
    assert.ok(rendered.includes('Insufficient data'), 'tile must render "insufficient data" when n < AI_ACCURACY_MIN_SAMPLE');
    assert.ok(rendered.includes('5 comparable ticket(s), need ≥ 10'), 'insufficient-data message must report both n and the threshold');
    assert.ok(!rendered.includes('card-label">MAE'), 'tile must NOT render computed MAE/Hit Rate/Sample cards below threshold');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('AC-27: "By User" table renders AI-SP / 1M tokens, crediting AI SP the same way the SP / 1M column does', async () => {
  const dir = await setupFixture('td-ac27-');
  try {
    // Fixture ticket PROJ-100 belongs entirely to alice's sessions, so
    // pickCreditUser's most-prompts fallback credits her (no assignee needed).
    fs.writeFileSync(path.join(dir, '.ai-memory', 'ai-estimates.json'), JSON.stringify({
      entries: {
        'PROJ-100': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-01T00:00:00.000Z' },
      },
    }));
    const r = runDashboard(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, '.claude', 'visualizations', 'token-dashboard.html'), 'utf8');

    // Header: "AI-SP / 1M tokens" column present with its own tooltip.
    assert.ok(html.includes('AI-SP / 1M tokens<span class="info">i</span></th>'),
      'By-User table must carry an "AI-SP / 1M tokens" <th> with a tooltip');
    assert.ok(html.includes('(AI SP credited × 1,000,000) ÷ tokens'),
      'per-cell tooltip must document the formula direction');

    const inline = extractInlineData(html);
    const result = runClientAiSpCreditedByUser(html, inline, inline.sessions, '2000-01-01', '2100-01-01');

    // Formula direction: (AI SP credited x 1,000,000) / tokens, using alice's
    // own session tokens pulled straight from the payload (no hardcoded fixture math).
    const aliceSession = inline.sessions.find(s => s.user === 'alice@example.com');
    assert.ok(aliceSession, 'alice must have a session in the fixture');
    const expectedAlice = (3 * 1e6) / (aliceSession.input_tokens + aliceSession.output_tokens);
    assert.equal(result['alice@example.com'], expectedAlice,
      'alice is credited the PROJ-100 AI estimate; per-1M value must follow (aiSp x 1e6) / tokens');
    assert.ok(result['alice@example.com'] > 0, 'a user with AI-credited SP and known tokens must show a non-zero value');
    assert.equal(result['bob@example.com'], 0, 'bob has no AI-estimated ticket credited to him, so his value is 0 (dash in the UI)');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
