#!/usr/bin/env node
'use strict';

// Fetches every ticket resolved (status = Done) within a window and caches
// it to .ai-memory/jira-period-tickets.json. This is the "delivered universe"
// the token dashboard diffs against the AI-tracked ticket set to surface work
// that shipped WITHOUT the workspace AI (the AI-coverage / untracked view).
//
// Unlike refresh-jira-story-points.js (keyed by tickets already seen in AI
// sessions), this queries Jira by date range, so it can include tickets AI
// never touched.
//
// Usage:
//   node scripts/refresh-jira-period-tickets.js                 # YTD → today
//   node scripts/refresh-jira-period-tickets.js --force         # bypass 24h TTL
//   node scripts/refresh-jira-period-tickets.js --from 2026-01-01 --to 2026-07-16
//
// Exits non-zero on credential / auth failure so cron pipelines surface it.

const path = require('node:path');
const { loadDotEnv } = require('./_lib/load-dotenv');
const { fetchDeliveredTickets } = require('./_lib/jira-story-points');

const ROOT_DIR = path.dirname(__dirname);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateArg(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1].trim();
  const eq = argv.find(a => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1).trim() : null;
}

function defaultWindow() {
  // YTD → today, in UTC (matches the dashboard's yearStart/today anchors).
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = `${now.getUTCFullYear()}-01-01`;
  return { from, to };
}

async function main(argv) {
  loadDotEnv(ROOT_DIR);

  const force = argv.includes('--force');
  const quiet = argv.includes('--quiet');
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const siteUrl = process.env.JIRA_BASE_URL || 'https://your-org.atlassian.net';

  const win = defaultWindow();
  const from = parseDateArg(argv, '--from') || win.from;
  const to = parseDateArg(argv, '--to') || win.to;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    log(`Invalid date(s): from=${from} to=${to} (expected YYYY-MM-DD)`);
    return 1;
  }

  log(`Refreshing delivered tickets for ${from} → ${to} (force=${force})`);
  const result = await fetchDeliveredTickets(ROOT_DIR, siteUrl, { from, to }, {
    cacheTtlMs: force ? 0 : undefined,
  });

  if (!result.available) {
    log(`Refresh failed: ${result.reason}${result.error ? ` (${result.error})` : ''}`);
    return quiet ? 0 : 1;
  }

  const entries = Object.values(result.byTicket);
  const withSp = entries.filter(e => e && e.sp > 0).length;
  const totalSp = entries.reduce((a, e) => a + (Number(e.sp) || 0), 0);
  log(`  Source: ${result.reason}`);
  log(`  Delivered tickets: ${entries.length}  (with SP: ${withSp}, total SP: ${totalSp})`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code || 0),
    err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); }
  );
}

module.exports = { defaultWindow, main };
