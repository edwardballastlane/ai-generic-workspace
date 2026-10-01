'use strict';

/**
 * memory-board — pure aggregation for the Team Memory Board (visualizes the
 * git-shared observation-export chunks). No I/O: the CLI reads the chunks and
 * passes {contributor, observations} in. Pure → unit-tested with fixtures.
 *
 * NOTE: observation title/content can name people or clients, so the board is
 * LOCAL-only (written under the gitignored .ai-memory/). Any SHAREABLE view must
 * use aggregate() output WITHOUT the `recent` titles.
 */

function dayOf(ts) { return String(ts || '').slice(0, 10); }

/**
 * @param {Array<{contributor,type,ts,project,title}>} obs  flattened observations
 * @param {{recentLimit?:number}} [opts]
 */
function aggregate(obs, opts = {}) {
  const { recentLimit = 25 } = opts;
  const rows = Array.isArray(obs) ? obs.filter(Boolean) : [];

  const byType = {};
  const byProject = {};
  const byDay = {};
  const contribMap = new Map();
  let first = '', last = '';

  for (const o of rows) {
    const type = String(o.type || 'unknown');
    const proj = String(o.project || '').trim() || '(unset)';
    const ts = String(o.ts || '');
    const c = String(o.contributor || 'unknown');
    byType[type] = (byType[type] || 0) + 1;
    byProject[proj] = (byProject[proj] || 0) + 1;
    if (ts) { const d = dayOf(ts); byDay[d] = (byDay[d] || 0) + 1; if (!first || ts < first) first = ts; if (ts > last) last = ts; }
    if (!contribMap.has(c)) contribMap.set(c, { name: c, count: 0, types: {}, first: '', last: '' });
    const cm = contribMap.get(c);
    cm.count++;
    cm.types[type] = (cm.types[type] || 0) + 1;
    if (ts) { if (!cm.first || ts < cm.first) cm.first = ts; if (ts > cm.last) cm.last = ts; }
  }

  const contributors = [...contribMap.values()].sort((a, b) => b.count - a.count);
  const timeline = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, count }));
  const recent = rows
    .filter((o) => o.ts)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, recentLimit)
    .map((o) => ({ contributor: o.contributor, type: o.type, ts: o.ts, title: o.title || '', project: o.project || '' }));

  return {
    totalObs: rows.length,
    contributorCount: contributors.length,
    span: { first: dayOf(first), last: dayOf(last) },
    byType, byProject, timeline, contributors, recent,
  };
}

module.exports = { aggregate, dayOf };
