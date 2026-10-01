#!/usr/bin/env node
'use strict';

// Pulls the *actual billed* cost from Anthropic's Admin Cost Report API and
// writes it to .ai-memory/admin-cost-<month>.json. This is the ground-truth
// counterpart to the dashboard's list-price estimate.
//
// IMPORTANT — what this number is, and is not:
//   The Cost Report reflects metered, usage-based billing for the org's
//   Developer Platform spend — the SAME number the Console "spent" tile shows.
//   It does NOT capture usage that a Claude Code / Max / Team SEAT subscription
//   already covers (that usage is paid via the seat, not metered as API spend).
//   So a heavy seat user can show ~$0 here while doing thousands of dollars of
//   list-price work. Treat this as "what hit the invoice as overage", and the
//   dashboard's cost_usd as "list-price value delivered" — two different,
//   both-valid metrics. Don't expect a stable ratio between them.
//
// Auth: set the ANTHROPIC_ADMIN_KEY environment variable to an Admin API key
// (Console -> Settings -> Admin keys), which is distinct from a normal API key
// and carries org-admin scope. Keep it out of the repo; inject it via a
// Bitbucket repository variable in CI.
//
// Usage — with ANTHROPIC_ADMIN_KEY exported, run:
//   node scripts/fetch-admin-cost.js                         # month-to-date
//   node scripts/fetch-admin-cost.js --month 2026-06
//   node scripts/fetch-admin-cost.js --from 2026-06-01 --to 2026-07-01

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = process.env.TOKEN_DASHBOARD_ROOT || path.dirname(__dirname);
const EVENTS_DIR = path.join(ROOT, '.ai-memory');
const API_HOST = 'api.anthropic.com';
const COST_PATH = '/v1/organizations/cost_report';

function parseArgs(argv) {
  const a = { month: null, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month') a.month = argv[++i];
    else if (argv[i] === '--from') a.from = argv[++i];
    else if (argv[i] === '--to') a.to = argv[++i];
  }
  return a;
}

// Resolve [starting_at, ending_at) as RFC 3339 UTC day boundaries. Defaults to
// the current calendar month (month-to-date) using a caller-injected "now" so
// the function stays testable.
function resolveRange({ month, from, to }, now = new Date()) {
  if (from) return { startingAt: `${from}T00:00:00Z`, endingAt: to ? `${to}T00:00:00Z` : null, month: from.slice(0, 7) };
  const ym = month || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const [y, m] = ym.split('-').map(Number);
  const startingAt = `${ym}-01T00:00:00Z`;
  // First day of the next month (exclusive upper bound).
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { startingAt, endingAt: `${next}-01T00:00:00Z`, month: ym };
}

function httpGet(urlPath, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: API_HOST,
      path: urlPath,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Walks every page of the cost report for the range, grouped by description so
// we get per-model / per-token-type line items. Returns the flat list of bucket
// result rows.
async function fetchAllResults({ startingAt, endingAt }, apiKey) {
  const rows = [];
  let page = null;
  // Guard against an unbounded loop if the API never clears has_more.
  for (let guard = 0; guard < 1000; guard++) {
    const qs = new URLSearchParams({ starting_at: startingAt, bucket_width: '1d' });
    if (endingAt) qs.set('ending_at', endingAt);
    qs.append('group_by[]', 'description');
    qs.append('group_by[]', 'workspace_id');
    if (page) qs.set('page', page);
    const resp = await httpGet(`${COST_PATH}?${qs.toString()}`, apiKey);
    for (const bucket of resp.data || []) {
      for (const r of bucket.results || []) {
        rows.push({ ...r, _starting_at: bucket.starting_at, _ending_at: bucket.ending_at });
      }
    }
    if (!resp.has_more || !resp.next_page) break;
    page = resp.next_page;
  }
  return rows;
}

// `amount` is a decimal string in the currency's lowest unit (cents for USD):
// "123.45" -> $1.2345. Convert to dollars.
function toDollars(amount) {
  return (Number(amount) || 0) / 100;
}

function summarize(rows) {
  let totalUsd = 0;
  const byModel = {};
  const byWorkspace = {};
  for (const r of rows) {
    const usd = toDollars(r.amount);
    totalUsd += usd;
    const model = r.model || `(${r.cost_type || 'other'})`;
    byModel[model] = (byModel[model] || 0) + usd;
    const ws = r.workspace_id || '(default)';
    byWorkspace[ws] = (byWorkspace[ws] || 0) + usd;
  }
  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { total_usd: Math.round(totalUsd * 100) / 100, by_model: round(byModel), by_workspace: round(byWorkspace) };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_ADMIN_KEY || '';
  if (!apiKey) {
    console.error('ANTHROPIC_ADMIN_KEY is required (an Admin API key from Console -> Settings -> Admin keys).');
    console.error('It is distinct from your normal API key and carries org-admin scope.');
    process.exit(1);
  }
  const range = resolveRange(parseArgs(process.argv.slice(2)));
  const month = range.month || range.startingAt.slice(0, 7);
  process.stderr.write(`Fetching cost report ${range.startingAt} -> ${range.endingAt || '(open)'}\n`);

  const rows = await fetchAllResults(range, apiKey);
  const summary = summarize(rows);

  const out = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    month,
    starting_at: range.startingAt,
    ending_at: range.endingAt,
    note: 'Metered usage-based spend (excludes seat-subscription-covered usage). See script header.',
    ...summary,
  };

  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  const outPath = path.join(EVENTS_DIR, `admin-cost-${month}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  console.log(`\nActual billed (metered) for ${month}: $${summary.total_usd.toFixed(2)}`);
  console.log('By model:');
  Object.entries(summary.by_model).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(28)} $${v.toFixed(2)}`));
  console.log(`\nWritten to ${path.relative(ROOT, outPath)}`);

  // Suggest an org-level calibration ratio against the dashboard's list price,
  // if the dashboard data is present. Org-level only — per-user/per-tier ratios
  // are unstable because seat coverage varies (see script header).
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'visualizations', 'token-data.json'), 'utf8'));
    const listPrice = Number(data.total && data.total.cost_usd) || 0;
    if (listPrice > 0) {
      console.log(`\nDashboard list-price (all history) cost_usd: $${listPrice.toFixed(2)}`);
      console.log('To derive a ratio, compare SAME-PERIOD numbers — regenerate the');
      console.log('dashboard for this month only, then ratio = billed / list-price.');
    }
  } catch { /* dashboard data not generated yet — skip suggestion */ }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message || err); process.exit(1); });
}

module.exports = { resolveRange, summarize, toDollars };
