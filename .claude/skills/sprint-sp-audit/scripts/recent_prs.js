#!/usr/bin/env node
'use strict';

/**
 * recent_prs.js — dump recent MERGED PRs (title + description + branch + diff size) as a
 * candidate pool for SEMANTIC ticket matching.
 *
 * Why this exists: many PRs — especially direct-to-master hotfixes — never carry the ticket
 * key in their branch, title, or description (the branch is descriptive like
 * `hotfix/networth-assets-excluded-master` and the body is just the PR template). Keyword
 * matching (match_prs.js) misses these entirely. The fix is to let the model read each PR's
 * title + description and match it to a ticket by meaning. This script produces that pool;
 * the SKILL.md tells the model how to map it.
 *
 * Auth: SAME ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN as Jira (one token covers Bitbucket Cloud).
 *
 * Usage:
 *   node recent_prs.js [--author "Jane Doe"] [--limit 40] [--repos a,b] [--since 2026-06-01]
 *
 * Output: JSON array of { repo, id, title, branch, author, merged_on, description (trimmed),
 * net_lines, files_changed, link }, newest first.
 */

const fs = require('node:fs');
const path = require('node:path');

// Bitbucket workspace + the repos to search, both configurable via the
// workspace .env (BITBUCKET_WORKSPACE, SP_AUDIT_REPOS="repo-a,repo-b") so this
// skill works in any org. --repos overrides the list per invocation.
const WORKSPACE = process.env.BITBUCKET_WORKSPACE || '';
const DEFAULT_REPOS = (process.env.SP_AUDIT_REPOS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const API = 'https://api.bitbucket.org/2.0';
const DESC_CAP = 600; // keep the pool compact — enough for the model to judge relevance

function loadAuth() {
  const env = fs.readFileSync(path.resolve(__dirname, '../../../../.env'), 'utf8');
  const unq = (s) => s.trim().replace(/^["']|["']$/g, '');
  const email = unq(env.match(/^ATLASSIAN_EMAIL\s*=\s*(.+)$/m)[1]);
  const token = unq(env.match(/^ATLASSIAN_API_TOKEN\s*=\s*(.+)$/m)[1]);
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function parseArgs(argv) {
  let author = null, limit = 40, since = null, repos = DEFAULT_REPOS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--author') author = argv[++i];
    else if (a === '--limit') limit = parseInt(argv[++i], 10);
    else if (a === '--since') since = argv[++i];
    else if (a === '--repos') repos = argv[++i].split(',').map((s) => s.trim());
  }
  return { author, limit, since, repos };
}

async function main() {
  const { author, limit, since, repos } = parseArgs(process.argv.slice(2));
  const AUTH = loadAuth();
  const sinceMs = since ? new Date(since).getTime() : 0;

  async function bb(p) {
    const r = await fetch(API + p, { headers: { Authorization: AUTH, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }

  const pool = [];
  for (const repo of repos) {
    let url = `/repositories/${WORKSPACE}/${repo}/pullrequests?state=MERGED&pagelen=50&sort=-updated_on&fields=values.id,values.title,values.description,values.updated_on,values.author.display_name,values.source.branch.name,values.links.html.href,next`;
    for (let pg = 0; url && pg < 6; pg++) {
      const d = await bb(url);
      let pastWindow = false;
      for (const p of d.values || []) {
        const mergedMs = new Date(p.updated_on).getTime();
        if (mergedMs < sinceMs) { pastWindow = true; continue; }
        if (author && p.author?.display_name !== author) continue;
        pool.push({ repo, p, mergedMs });
      }
      url = (d.next && !pastWindow) ? d.next.replace(API, '') : null;
    }
  }

  // Newest first, cap to limit, then fetch diffstat only for the survivors.
  pool.sort((a, b) => b.mergedMs - a.mergedMs);
  const top = pool.slice(0, limit);
  const out = [];
  for (const { repo, p } of top) {
    let added = 0, removed = 0, files = 0;
    try {
      const ds = await bb(`/repositories/${WORKSPACE}/${repo}/pullrequests/${p.id}/diffstat?pagelen=100&fields=values.lines_added,values.lines_removed`);
      for (const f of ds.values || []) { added += f.lines_added || 0; removed += f.lines_removed || 0; files++; }
    } catch { /* optional */ }
    const desc = (p.description || '').replace(/\s+/g, ' ').trim();
    out.push({
      repo,
      id: p.id,
      title: p.title,
      branch: p.source?.branch?.name || '',
      author: p.author?.display_name || null,
      merged_on: p.updated_on,
      description: desc.length > DESC_CAP ? desc.slice(0, DESC_CAP) + '…' : desc,
      net_lines: added + removed,
      files_changed: files,
      link: p.links?.html?.href || `https://bitbucket.org/${WORKSPACE}/${repo}/pull-requests/${p.id}`,
    });
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
