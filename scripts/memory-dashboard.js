#!/usr/bin/env node
'use strict';

/**
 * memory-dashboard — render a local "Team Memory Board" from the git-shared
 * observation-export chunks (.ai-memory/observations-export/*.jsonl).
 *
 * Output is written to .ai-memory/team-memory-board.html — under the gitignored
 * .ai-memory/, so it is NEVER committed (observation titles can name customers).
 * Self-contained (inline CSS, no CDN) so it opens offline.
 *
 * Usage: npm run memory:board   (add --no-open to skip launching the browser)
 */

const fs = require('node:fs');
const path = require('node:path');
const { aggregate } = require('./_lib/memory-board');

function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let cur = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function readChunks(root) {
  const dir = path.join(root, '.ai-memory', 'observations-export');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return out; }
  for (const f of files) {
    const contributor = f.replace(/\.jsonl$/, '');
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); out.push({ ...o, contributor }); } catch { /* skip */ }
    }
  }
  return out;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TYPE_COLORS = {
  session_summary: '#5b8def', decision: '#5bd0ab', bugfix: '#f2765f', architecture: '#c08cf5',
  pattern: '#e6a95c', discovery: '#4dc9d6', config: '#9aa0aa', feature: '#e178c5', preference: '#7c86f0', unknown: '#6b7280',
};
const color = (t) => TYPE_COLORS[t] || '#6b7280';

function bar(label, count, max, c) {
  const pct = max ? Math.round((count / max) * 100) : 0;
  return `<div class="row"><span class="lbl">${esc(label)}</span><span class="track"><span class="fill" style="width:${pct}%;background:${c}"></span></span><span class="num">${count}</span></div>`;
}

function render(a) {
  const maxType = Math.max(1, ...Object.values(a.byType));
  const maxContrib = Math.max(1, ...a.contributors.map((c) => c.count));
  const maxProj = Math.max(1, ...Object.values(a.byProject));
  const maxDay = Math.max(1, ...a.timeline.map((d) => d.count));

  const typeBars = Object.entries(a.byType).sort((x, y) => y[1] - x[1])
    .map(([t, n]) => bar(t.replace(/_/g, ' '), n, maxType, color(t))).join('');
  const contribBars = a.contributors
    .map((c) => bar(c.name, c.count, maxContrib, '#5b8def')).join('');
  const projBars = Object.entries(a.byProject).sort((x, y) => y[1] - x[1])
    .map(([p, n]) => bar(p, n, maxProj, '#5bd0ab')).join('');
  const spark = a.timeline.map((d) =>
    `<span class="spk" style="height:${Math.max(6, Math.round((d.count / maxDay) * 64))}px" title="${d.day}: ${d.count}"></span>`).join('');
  const recent = a.recent.map((o) =>
    `<li data-type="${esc(o.type)}" data-contrib="${esc(o.contributor)}"><span class="dot" style="background:${color(o.type)}"></span><span class="rc">${esc(o.contributor)}</span>
     <span class="rt" style="color:${color(o.type)}">${esc(o.type)}</span>
     <span class="rd">${esc(String(o.ts).slice(0, 10))}</span>
     <span class="rp">${esc(o.project || '')}</span>
     <div class="rttl">${esc(o.title)}</div></li>`).join('');

  // Filter chips: All + one per type (colored) and one per contributor.
  const typeChips = ['<button class="chip active" data-fType="*">all types</button>']
    .concat(Object.keys(a.byType).sort().map((t) =>
      `<button class="chip" data-fType="${esc(t)}"><span class="dot" style="background:${color(t)}"></span>${esc(t.replace(/_/g, ' '))} (${a.byType[t]})</button>`)).join('');
  const contribChips = ['<button class="chip active" data-fContrib="*">all contributors</button>']
    .concat(a.contributors.map((c) =>
      `<button class="chip" data-fContrib="${esc(c.name)}">${esc(c.name)} (${c.count})</button>`)).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Memory Board</title><style>
:root{--bg:#14121a;--card:#1e1b26;--line:#312b3d;--text:#ece6f2;--muted:#9990a6;--mono:ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,system-ui,sans-serif;line-height:1.5}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:30px;font-weight:800;letter-spacing:-.02em;margin:0 0 4px}
.sub{color:var(--muted);font-family:var(--mono);font-size:13px;margin:0 0 4px}
.warn{color:#e6a95c;font-size:12px;font-family:var(--mono);margin:8px 0 24px}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin:20px 0 28px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;min-width:150px}
.stat .k{font-size:32px;font-weight:800;letter-spacing:-.02em}
.stat .l{color:var(--muted);font-size:12px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
.card h2{font-size:14px;margin:0 0 14px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.card.full{grid-column:1/-1}
.row{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:13px}
.lbl{width:150px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{flex:1;height:9px;background:#0f0d14;border-radius:5px;overflow:hidden}
.fill{display:block;height:100%;border-radius:5px}
.num{width:38px;text-align:right;font-family:var(--mono);color:var(--muted)}
.spark{display:flex;align-items:flex-end;gap:3px;height:70px;padding-top:6px}
.spk{flex:1;background:#5b8def;border-radius:2px 2px 0 0;min-width:2px;opacity:.85}
ul.recent{list-style:none;margin:0;padding:0}
ul.recent li{border-bottom:1px solid var(--line);padding:10px 0;display:grid;grid-template-columns:auto auto auto auto 1fr;gap:8px;align-items:center;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%}
.rc{font-weight:600}.rt{font-family:var(--mono);font-size:11px}.rd{color:var(--muted);font-family:var(--mono)}.rp{color:var(--muted)}
.rttl{grid-column:1/-1;color:#cabfd6;font-size:13px;padding-left:16px}
ul.recent li.hidden{display:none}
.filters{margin:0 0 14px}
.filters .frow{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.chip{background:#0f0d14;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:4px 11px;font-size:12px;font-family:var(--mono);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.chip:hover{border-color:#5b8def}
.chip.active{background:#2a2740;border-color:#5b8def;color:var(--text)}
.chip .dot{width:8px;height:8px;border-radius:50%}
.fcount{color:var(--muted);font-family:var(--mono);font-size:12px;margin-left:8px}
@media(max-width:760px){.grid{grid-template-columns:1fr}.lbl{width:110px}}
</style></head><body><div class="wrap">
<h1>Team Memory Board</h1>
<p class="sub">shared observations · ${esc(a.span.first)} → ${esc(a.span.last)} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</p>
<p class="warn">⚠ local-only — observation titles may name customers; never commit or share this file externally.</p>
<div class="stats">
  <div class="stat"><div class="k">${a.totalObs}</div><div class="l">observations</div></div>
  <div class="stat"><div class="k">${a.contributorCount}</div><div class="l">contributors</div></div>
  <div class="stat"><div class="k">${Object.keys(a.byType).length}</div><div class="l">types</div></div>
  <div class="stat"><div class="k">${Object.keys(a.byProject).length}</div><div class="l">projects</div></div>
</div>
<div class="card full" style="margin-bottom:16px"><h2>Sharing activity (observations / day)</h2><div class="spark">${spark}</div></div>
<div class="grid">
  <div class="card"><h2>Contributors</h2>${contribBars}</div>
  <div class="card"><h2>By type</h2>${typeBars}</div>
  <div class="card"><h2>By project</h2>${projBars}</div>
  <div class="card"><h2>Types legend</h2>${Object.keys(TYPE_COLORS).map((t) => `<div class="row"><span class="dot" style="background:${color(t)}"></span><span class="lbl">${t.replace(/_/g, ' ')}</span></div>`).join('')}</div>
  <div class="card full">
    <h2>Shared observations (${a.recent.length} of ${a.totalObs})<span class="fcount" id="fcount"></span></h2>
    <div class="filters">
      <div class="frow" id="type-filters">${typeChips}</div>
      <div class="frow" id="contrib-filters">${contribChips}</div>
    </div>
    <ul class="recent" id="obs-list">${recent || '<li>(none)</li>'}</ul>
  </div>
</div>
<script>
  (function () {
    var fType = '*', fContrib = '*';
    var items = Array.prototype.slice.call(document.querySelectorAll('#obs-list li'));
    var fcount = document.getElementById('fcount');
    function apply() {
      var shown = 0;
      items.forEach(function (li) {
        var ok = (fType === '*' || li.getAttribute('data-type') === fType)
              && (fContrib === '*' || li.getAttribute('data-contrib') === fContrib);
        li.classList.toggle('hidden', !ok);
        if (ok) shown++;
      });
      if (fcount) fcount.textContent = '— showing ' + shown;
    }
    function wire(sel, attr, set) {
      document.querySelectorAll(sel).forEach(function (btn) {
        btn.addEventListener('click', function () {
          document.querySelectorAll(sel).forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          set(btn.getAttribute(attr));
          apply();
        });
      });
    }
    wire('#type-filters .chip', 'data-fType', function (v) { fType = v; });
    wire('#contrib-filters .chip', 'data-fContrib', function (v) { fContrib = v; });
    apply();
  })();
</script>
</div></body></html>`;
}

function main() {
  const root = findWorkspaceRoot();
  // How many observations to list. Default shows ALL (this is the "check what's shared"
  // tool); pass --recent N for the N most recent instead.
  const ri = process.argv.indexOf('--recent');
  const recentLimit = ri !== -1 && process.argv[ri + 1] ? (Number(process.argv[ri + 1]) || 25) : Infinity;
  const a = aggregate(readChunks(root), { recentLimit });
  const outPath = path.join(root, '.ai-memory', 'team-memory-board.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, render(a));
  console.log(`Team Memory Board: ${a.totalObs} observations from ${a.contributorCount} contributors (${a.span.first} → ${a.span.last})`);
  console.log(`  → ${path.relative(root, outPath)} (local-only, gitignored)`);
  if (!process.argv.includes('--no-open')) {
    const { execFile } = require('node:child_process');
    // `start` is a cmd.exe builtin rather than an executable, so Windows needs the
    // shell host named explicitly; every platform still gets the path as its own
    // argv entry, never spliced into a command string.
    const OPENERS = { darwin: ['open', []], win32: ['cmd', ['/c', 'start', '']] };
    const [bin, prefix] = OPENERS[process.platform] || ['xdg-open', []];
    execFile(bin, [...prefix, outPath], () => {});
  }
}

if (require.main === module) main();

module.exports = { readChunks, render, findWorkspaceRoot };
