#!/usr/bin/env node
'use strict';

// Reads .ai-memory/session-end-events.jsonl, collects every distinct
// primary_jira_ticket / jira_ticket value, and populates the SP cache at
// .ai-memory/jira-story-points.json. The token dashboard reads from that file
// directly, so teammates without Jira credentials can still render the
// "AI Adoption" section once this file is committed to git.
//
// Usage:
//   node scripts/refresh-jira-story-points.js
//   node scripts/refresh-jira-story-points.js --force   # bypass 24h cache TTL
//
// Exits non-zero on credential / auth failure so cron pipelines surface it.

const path = require('node:path');
const { loadDotEnv } = require('./_lib/load-dotenv');
const { fetchStoryPoints } = require('./_lib/jira-story-points');
const { readAllLines } = require('./_lib/session-events');

const ROOT_DIR = path.dirname(__dirname);
const TICKET_RE = /^[A-Z]+-\d+$/;

function readDistinctTickets(root) {
  const tickets = new Set();
  for (const line of readAllLines(root)) { // legacy archive + every monthly shard
    try {
      const ev = JSON.parse(line);
      const k = (ev.primary_jira_ticket || ev.jira_ticket || '').trim();
      if (TICKET_RE.test(k)) tickets.add(k);
    } catch { /* skip malformed */ }
  }
  return [...tickets];
}

function parseTicketArg(argv) {
  // Supports --ticket KEY, --ticket=KEY.
  const i = argv.indexOf('--ticket');
  if (i >= 0 && argv[i + 1]) return argv[i + 1].trim();
  const eq = argv.find(a => a.startsWith('--ticket='));
  return eq ? eq.slice(9).trim() : null;
}

async function main(argv) {
  loadDotEnv(ROOT_DIR);

  const force = argv.includes('--force');
  const quiet = argv.includes('--quiet');
  const singleTicket = parseTicketArg(argv);
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const siteUrl = process.env.JIRA_BASE_URL;
  if (!siteUrl) {
    log('JIRA_BASE_URL is not set (e.g. https://your-org.atlassian.net). Skipping refresh.');
    return 0;
  }

  let tickets;
  if (singleTicket) {
    if (!TICKET_RE.test(singleTicket)) {
      log(`Invalid ticket key: ${singleTicket}`);
      return 0;
    }
    tickets = [singleTicket];
  } else {
    tickets = readDistinctTickets(ROOT_DIR);
  }

  log(`Refreshing Jira story points for ${tickets.length} ticket(s)${singleTicket ? ` [${singleTicket}]` : ''} (force=${force})`);
  if (tickets.length === 0) {
    log('Nothing to refresh.');
    return 0;
  }

  const result = await fetchStoryPoints(ROOT_DIR, siteUrl, tickets, {
    cacheTtlMs: force ? 0 : undefined,
  });

  if (!result.available) {
    log(`Refresh failed: ${result.reason}${result.error ? ` (${result.error})` : ''}`);
    return quiet ? 0 : 1;
  }

  log(`  Field: ${result.spField}`);
  log(`  Fetched from Jira: ${result.fetched}`);
  log(`  Served from cache: ${result.fromCache}`);
  const withSp = Object.values(result.byTicket).filter(e => !e.error && e.sp > 0).length;
  log(`  Tickets with non-zero SP: ${withSp}/${tickets.length}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code || 0),
    err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); }
  );
}

module.exports = { readDistinctTickets, main };
