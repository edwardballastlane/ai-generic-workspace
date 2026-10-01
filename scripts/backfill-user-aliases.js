#!/usr/bin/env node
'use strict';

// One-shot: rewrite the `user` field of session events through the alias map in
// .ai-memory/user-aliases.json, so historical telemetry is attributed to the
// canonical name at the source (not just at dashboard read time). The dashboard
// already normalizes on read; this makes every other consumer (reports, token
// reports) consistent too.
//
// Usage:
//   node scripts/backfill-user-aliases.js            # apply
//   node scripts/backfill-user-aliases.js --dry-run  # report only, write nothing
//
// Lines that don't change are left byte-for-byte intact, so closed-month shards
// with no aliased users produce no diff.

const fs = require('node:fs');
const { listEventFiles } = require('./_lib/session-events');
const { loadUserAliases, canonicalUser } = require('./_lib/user-aliases');

const ROOT = process.env.TOKEN_DASHBOARD_ROOT || require('node:path').dirname(__dirname);
const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  const aliases = loadUserAliases(ROOT);
  if (!Object.keys(aliases).length) {
    console.log('No aliases configured in .ai-memory/user-aliases.json — nothing to do.');
    return;
  }
  console.log('Aliases:', JSON.stringify(aliases));

  let totalChanged = 0;
  for (const file of listEventFiles(ROOT)) {
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split('\n');
    let changed = 0;
    const out = lines.map(line => {
      const t = line.trim();
      if (!t) return line;
      let e;
      try { e = JSON.parse(t); } catch { return line; } // leave malformed lines alone
      if (!e || !e.user) return line;
      const canon = canonicalUser(e.user, aliases);
      if (canon === e.user) return line;
      e.user = canon;
      changed += 1;
      return JSON.stringify(e);
    });
    if (changed) {
      totalChanged += changed;
      console.log(`${DRY_RUN ? '[dry-run] ' : ''}${file}: ${changed} event(s) remapped`);
      if (!DRY_RUN) fs.writeFileSync(file, out.join('\n'));
    }
  }
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Done. ${totalChanged} event(s) ${DRY_RUN ? 'would be ' : ''}remapped.`);
}

main();
