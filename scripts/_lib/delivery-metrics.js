'use strict';

// Pure delivery/velocity/ROI math for the token dashboard's "Delivery & ROI"
// section. Framework-free (no DOM, no globals) so it can be BOTH unit-tested in
// Node AND embedded verbatim into the dashboard's client <script> (single source
// of truth — the renderer inlines this file's source, exactly like cost.js is
// single-sourced for pricing). Keep it dependency-free and browser-safe:
// function declarations only, guarded module.exports at the bottom.

function businessDaysBetween(from, to) {
  var d = new Date(from + 'T00:00:00Z');
  var end = new Date(to + 'T00:00:00Z');
  var n = 0;
  while (d <= end) {
    var wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
    d = new Date(d.getTime() + 86400000);
  }
  return Math.max(1, n);
}

// delivered: [{ key, sp, assignee, type, resolved, summary }]
// aiKeys:    array or Set of Jira keys with an AI session in the window
// cfg:       { available, roster:[{jira_name, role, allocation}], baseline:{be_sp_fte_mo, fe_sp_fte_mo}, jira_aliases }
// opts:      { from, to }  (YYYY-MM-DD window bounds)
function computeDeliveryMetrics(delivered, aiKeys, cfg, opts) {
  var options = opts || {};
  var from = options.from;
  var to = options.to;

  var keySet = (aiKeys instanceof Set) ? aiKeys : new Set(aiKeys || []);
  var totalSp = delivered.reduce(function (a, d) { return a + (Number(d.sp) || 0); }, 0);
  var tracked = delivered.filter(function (d) { return keySet.has(d.key); });
  var untracked = delivered.filter(function (d) { return !keySet.has(d.key); });
  var trackedSp = tracked.reduce(function (a, d) { return a + (Number(d.sp) || 0); }, 0);
  var untrackedSp = totalSp - trackedSp;

  var days = Math.max(1, Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000));
  var weeks = days / 7;
  var months = days / 30;
  var bizDays = businessDaysBetween(from, to);

  var available = cfg && cfg.available === true;
  var roster = (available && Array.isArray(cfg.roster)) ? cfg.roster : [];
  var aliases = (cfg && cfg.jira_aliases) || {};
  var roleByName = {};
  roster.forEach(function (r) { roleByName[r.jira_name] = r.role; });
  function roleOf(name) { return roleByName[(aliases[name] || name)]; }

  var fteByRole = { BE: 0, FE: 0 };
  roster.forEach(function (r) { if (fteByRole[r.role] != null) fteByRole[r.role] += r.allocation; });
  var teamFte = fteByRole.BE + fteByRole.FE;

  var spByRole = { BE: 0, FE: 0 };
  delivered.forEach(function (d) {
    var role = roleOf(d.assignee);
    if (role && spByRole[role] != null) spByRole[role] += (Number(d.sp) || 0);
  });
  var rosterSp = spByRole.BE + spByRole.FE;

  var baseline = (cfg && cfg.baseline) || {};
  var baseByRole = { BE: baseline.be_sp_fte_mo, FE: baseline.fe_sp_fte_mo };

  function seg(label, sp, fte, base) {
    var spFteMo = fte > 0 ? (sp / months) / fte : null;
    var spFteDay = fte > 0 ? sp / (bizDays * fte) : null;
    var mult = (spFteMo != null && base) ? spFteMo / base : null;
    return { label: label, sp: sp, fte: fte, spFteMo: spFteMo, spFteDay: spFteDay, base: base || null, mult: mult };
  }
  var teamBase = (teamFte > 0 && baseByRole.BE != null && baseByRole.FE != null)
    ? (baseByRole.BE * fteByRole.BE + baseByRole.FE * fteByRole.FE) / teamFte
    : null;
  var segments = [
    seg('Team', rosterSp, teamFte, teamBase),
    seg('Backend', spByRole.BE, fteByRole.BE, baseByRole.BE),
    seg('Frontend', spByRole.FE, fteByRole.FE, baseByRole.FE),
  ];

  // Per-developer velocity: each roster member's delivered SP (alias-folded),
  // normalized to their own FTE/allocation, vs their role's pre-AI baseline.
  var perDevMap = {};
  roster.forEach(function (r) {
    perDevMap[r.jira_name] = { name: r.jira_name, role: r.role, fte: r.allocation, sp: 0, tickets: 0, tracked: 0 };
  });
  delivered.forEach(function (d) {
    var canon = aliases[d.assignee] || d.assignee;
    var pd = perDevMap[canon];
    if (!pd) return;
    pd.sp += (Number(d.sp) || 0);
    pd.tickets += 1;
    if (keySet.has(d.key)) pd.tracked += 1;
  });
  var perDev = Object.keys(perDevMap).map(function (k) {
    var pd = perDevMap[k];
    var base = (pd.role === 'BE') ? baseByRole.BE : baseByRole.FE;
    pd.spFteMo = pd.fte > 0 ? (pd.sp / months) / pd.fte : null;
    pd.spFteDay = pd.fte > 0 ? pd.sp / (bizDays * pd.fte) : null;
    pd.base = base || null;
    pd.mult = (pd.spFteMo != null && base) ? pd.spFteMo / base : null;
    pd.spWeek = pd.sp / weeks;
    pd.spMonth = pd.sp / months;
    pd.untracked = pd.tickets - pd.tracked;
    pd.coverage = pd.tickets ? (pd.tracked / pd.tickets) * 100 : 0;
    return pd;
  }).sort(function (a, b) { return b.sp - a.sp; });

  return {
    delivered: delivered, tracked: tracked, untracked: untracked,
    totalSp: totalSp, rosterSp: rosterSp, trackedSp: trackedSp, untrackedSp: untrackedSp,
    days: days, weeks: weeks, months: months, bizDays: bizDays,
    roster: roster, teamFte: teamFte, segments: segments, perDev: perDev,
    spWeek: totalSp / weeks,
    spMonth: totalSp / months,
    coverageCount: delivered.length ? (tracked.length / delivered.length) * 100 : 0,
    coverageSp: totalSp ? (trackedSp / totalSp) * 100 : 0,
    cfgAvailable: available,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { businessDaysBetween, computeDeliveryMetrics };
}
