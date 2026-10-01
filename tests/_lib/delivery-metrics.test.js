'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { businessDaysBetween, computeDeliveryMetrics } = require('../../scripts/_lib/delivery-metrics');

const CFG = {
  available: true,
  monthly_cost_total: 30000,
  baseline: { be_sp_fte_mo: 8.7, fe_sp_fte_mo: 14.9 },
  roster: [
    { jira_name: 'Alice BE', role: 'BE', allocation: 1.0 },
    { jira_name: 'Bob BE', role: 'BE', allocation: 1.0 },
    { jira_name: 'Carol FE', role: 'FE', allocation: 1.0 },
  ],
  jira_aliases: { 'alice': 'Alice BE' },
};

function delivered() {
  return [
    { key: 'PROJ-1', sp: 5, assignee: 'Alice BE', type: 'Story', resolved: '2026-06-05' },
    { key: 'PROJ-2', sp: 3, assignee: 'alice', type: 'Bug', resolved: '2026-06-10' }, // alias → Alice BE
    { key: 'PROJ-3', sp: 2, assignee: 'Carol FE', type: 'Task', resolved: '2026-06-15' },
    { key: 'PROJ-4', sp: 8, assignee: 'Nonroster Person', type: 'Story', resolved: '2026-06-20' },
  ];
}

test('businessDaysBetween excludes weekends and is inclusive', () => {
  // Mon 2026-06-01 .. Fri 2026-06-05 = 5 business days
  assert.equal(businessDaysBetween('2026-06-01', '2026-06-05'), 5);
  // Full week incl. weekend Mon..Sun = still 5
  assert.equal(businessDaysBetween('2026-06-01', '2026-06-07'), 5);
  // Single Saturday floors to the 1-day minimum (never zero → no divide-by-zero)
  assert.equal(businessDaysBetween('2026-06-06', '2026-06-06'), 1);
});

test('totalSp counts every delivered ticket; rosterSp excludes non-roster assignees', () => {
  const m = computeDeliveryMetrics(delivered(), [], CFG, { from: '2026-06-01', to: '2026-06-30', aiCost: 0 });
  assert.equal(m.totalSp, 18);         // 5+3+2+8
  assert.equal(m.rosterSp, 10);        // 5+3 (Alice via alias) + 2 (Carol); 8 non-roster excluded
});

test('alias folds a display-name variant onto the roster role', () => {
  const m = computeDeliveryMetrics(delivered(), [], CFG, { from: '2026-06-01', to: '2026-06-30', aiCost: 0 });
  const be = m.segments.find(s => s.label === 'Backend');
  assert.equal(be.sp, 8);              // Alice(5) + alice(3) via alias
  const fe = m.segments.find(s => s.label === 'Frontend');
  assert.equal(fe.sp, 2);             // Carol only
});

test('coverage diff splits tracked vs untracked by AI key set', () => {
  const m = computeDeliveryMetrics(delivered(), ['PROJ-1', 'PROJ-3'], CFG, { from: '2026-06-01', to: '2026-06-30', aiCost: 0 });
  assert.equal(m.tracked.length, 2);
  assert.equal(m.untracked.length, 2);
  assert.equal(m.trackedSp, 7);        // PROJ-1(5) + PROJ-3(2)
  assert.equal(m.untrackedSp, 11);     // 18 - 7
  assert.equal(m.coverageCount, 50);   // 2/4 tickets
});

test('SP/FTE/mo normalizes to a monthly rate and matches pre-AI baseline shape', () => {
  // 30-day window → months = 1. BE rosterSp 8 over 2.0 FTE → 4.0 SP/FTE/mo.
  const m = computeDeliveryMetrics(delivered(), [], CFG, { from: '2026-06-01', to: '2026-07-01', aiCost: 0 });
  const be = m.segments.find(s => s.label === 'Backend');
  assert.equal(Math.round(be.spFteMo * 100) / 100, 4);         // (8/1)/2.0
  assert.equal(Math.round(be.mult * 1000) / 1000, Math.round((4 / 8.7) * 1000) / 1000); // 4 ÷ 8.7 baseline
});

test('window length changes SP/month but a doubled window keeps the monthly rate stable', () => {
  const short = computeDeliveryMetrics(delivered(), [], CFG, { from: '2026-06-01', to: '2026-07-01' }); // 30d
  const long = computeDeliveryMetrics(delivered(), [], CFG, { from: '2026-06-01', to: '2026-07-31' });  // 60d
  // Same SP, double the window → SP/month roughly halves (normalization works).
  assert.ok(long.spMonth < short.spMonth);
  assert.equal(short.totalSp, long.totalSp);
});

test('no money/cost metrics are emitted (removed per product decision)', () => {
  const m = computeDeliveryMetrics(delivered(), ['PROJ-1'], CFG, { from: '2026-06-01', to: '2026-07-01' });
  assert.equal(m.aiCostPerSp, undefined);
  assert.equal(m.blendedPerSp, undefined);
  assert.equal(m.aiPctPayroll, undefined);
  assert.equal(m.monthlyCost, undefined);
});

test('per-developer velocity: SP, FTE-normalized rate, coverage, and baseline multiplier', () => {
  const m = computeDeliveryMetrics(delivered(), ['PROJ-1'], CFG, { from: '2026-06-01', to: '2026-07-01' });
  const alice = m.perDev.find(d => d.name === 'Alice BE');
  assert.equal(alice.sp, 8);                 // PROJ-1(5) + PROJ-2(3 via alias)
  assert.equal(alice.tickets, 2);
  assert.equal(alice.tracked, 1);            // only PROJ-1 is AI-tracked
  assert.equal(alice.coverage, 50);          // 1/2
  assert.equal(Math.round(alice.spFteMo * 100) / 100, 8);  // (8/1)/1.0 FTE
  assert.equal(Math.round(alice.mult * 1000) / 1000, Math.round((8 / 8.7) * 1000) / 1000);
  // Non-roster assignees never appear in perDev.
  assert.ok(!m.perDev.some(d => d.name === 'Nonroster Person'));
  // perDev is sorted by SP desc.
  const spSeq = m.perDev.map(d => d.sp);
  for (let i = 1; i < spSeq.length; i++) assert.ok(spSeq[i - 1] >= spSeq[i]);
});

test('config unavailable → roster-based tables empty, but throughput still computed', () => {
  const m = computeDeliveryMetrics(delivered(), ['PROJ-1'], { available: false }, {
    from: '2026-06-01', to: '2026-07-01',
  });
  assert.equal(m.totalSp, 18);
  assert.equal(m.coverageCount, 25);
  assert.equal(m.cfgAvailable, false);
  assert.equal(m.perDev.length, 0);
});

test('empty delivered set does not divide by zero', () => {
  const m = computeDeliveryMetrics([], [], CFG, { from: '2026-06-01', to: '2026-07-01' });
  assert.equal(m.totalSp, 0);
  assert.equal(m.coverageCount, 0);
  assert.equal(m.perDev.every(d => d.sp === 0), true);
});
