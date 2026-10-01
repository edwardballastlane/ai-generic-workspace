#!/usr/bin/env node
'use strict';

/**
 * match_prs.js — match Jira tickets to MERGED Bitbucket PRs and pull real diff effort.
 *
 * PRs are a much stronger effort signal than the AI session log: the ticket key almost
 * always lives in the source branch name (feature/PROJ-865-...) or PR title, and the
 * diffstat gives actual lines changed + files touched on the merged work.
 *
 * Auth: the SAME Atlassian unified API token used for Jira (ATLASSIAN_EMAIL +
 * ATLASSIAN_API_TOKEN in the workspace .env) — one token covers Bitbucket Cloud.
 *
 * Usage:
 *   node match_prs.js PROJ-865 PROJ-866 [...keys] [--author "Jane Doe"] [--repos a,b]
 *
 * Output: JSON keyed by ticket. Each ticket lists its matched merged PRs (id, title,
 * branch, author, merged_on, lines_added/removed, files_changed, link) plus aggregate
 * net_lines / files / pr_count. Tickets with no merged PR come back with prs: [].
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

function loadAuth() {
  const envPath = path.resolve(__dirname, '../../../../.env');
  const env = fs.readFileSync(envPath, 'utf8');
  const unq = (s) => s.trim().replace(/^["']|["']$/g, '');
  const email = unq(env.match(/^ATLASSIAN_EMAIL\s*=\s*(.+)$/m)[1]);
  const token = unq(env.match(/^ATLASSIAN_API_TOKEN\s*=\s*(.+)$/m)[1]);
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function parseArgs(argv) {
  const keys = [];
  let author = null;
  let repos = DEFAULT_REPOS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--author') author = argv[++i];
    else if (a === '--repos') repos = argv[++i].split(',').map((s) => s.trim());
    else if (!a.startsWith('--')) keys.push(a.toUpperCase());
  }
  return { keys, author, repos };
}

async function main() {
  const { keys, author, repos } = parseArgs(process.argv.slice(2));
  const AUTH = loadAuth();

  async function bb(p) {
    const r = await fetch(API + p, { headers: { Authorization: AUTH, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }

  const out = {};
  for (const key of keys) {
    out[key] = { prs: [], pr_count: 0, lines_added: 0, lines_removed: 0, net_lines: 0, files_changed: 0 };
    // Target the key directly: match on title OR source branch name. Far cheaper than
    // paging the full merged-PR history, and the branch carries the key even when the
    // title doesn't.
    const q = encodeURIComponent(`state="MERGED" AND (title~"${key}" OR source.branch.name~"${key}" OR description~"${key}")`);
    for (const repo of repos) {
      let data;
      try {
        data = await bb(`/repositories/${WORKSPACE}/${repo}/pullrequests?q=${q}&pagelen=50&fields=values.id,values.title,values.description,values.updated_on,values.created_on,values.author.display_name,values.source.branch.name,values.links.html.href`);
      } catch (e) {
        // A repo the token can't see, or a malformed query — record and move on.
        out[key].prs.push({ repo, error: String(e.message) });
        continue;
      }
      for (const p of data.values || []) {
        const branch = p.source?.branch?.name || '';
        const title = p.title || '';
        // Guard against substring false positives (PROJ-138 matching PROJ-1380): require a word boundary.
        const re = new RegExp(`${key}(?!\\d)`, 'i');
        if (!re.test(branch) && !re.test(title) && !re.test(p.description || '')) continue;
        if (author && p.author?.display_name !== author) continue;

        let added = 0, removed = 0, files = 0;
        try {
          const ds = await bb(`/repositories/${WORKSPACE}/${repo}/pullrequests/${p.id}/diffstat?pagelen=100&fields=values.lines_added,values.lines_removed`);
          for (const f of ds.values || []) { added += f.lines_added || 0; removed += f.lines_removed || 0; files++; }
        } catch { /* diffstat optional */ }

        out[key].prs.push({
          repo,
          id: p.id,
          title,
          branch,
          author: p.author?.display_name || null,
          merged_on: p.updated_on,
          lines_added: added,
          lines_removed: removed,
          files_changed: files,
          link: p.links?.html?.href || `https://bitbucket.org/${WORKSPACE}/${repo}/pull-requests/${p.id}`,
        });
        out[key].lines_added += added;
        out[key].lines_removed += removed;
        out[key].files_changed += files;
      }
    }
    out[key].pr_count = out[key].prs.filter((x) => !x.error).length;
    out[key].net_lines = out[key].lines_added + out[key].lines_removed;
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
