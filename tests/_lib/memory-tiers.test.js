'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { defaultTier, tierOf, classify, THRESHOLD_DAYS } = require('../../scripts/_lib/memory-tiers');

const NOW = Date.parse('2026-09-11T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('defaultTier: only session_summary is perishable; curated types are pinned (aging is opt-in)', () => {
  assert.equal(defaultTier('session_summary'), 'perishable');
  assert.equal(defaultTier('decision'), 'pinned');
  assert.equal(defaultTier('architecture'), 'pinned');
  assert.equal(defaultTier('bugfix'), 'pinned');       // curated → pinned (no obs reinforcement)
  assert.equal(defaultTier('discovery'), 'pinned');
});

test('explicit tier overrides the type default (aging is opt-in)', () => {
  assert.equal(tierOf({ type: 'bugfix', tier: 'aging' }), 'aging');     // opt into decay
  assert.equal(tierOf({ type: 'bugfix' }), 'pinned');                   // default durable
  assert.equal(tierOf({ type: 'decision', tier: 'bogus' }), 'pinned');  // invalid override ignored
});

test('pinned never decays (no clock read)', () => {
  const r = classify({ type: 'decision', ts: daysAgo(9999) }, NOW);
  assert.equal(r.tier, 'pinned');
  assert.equal(r.stale, false);
  assert.equal(r.ageDays, null);
});

test('aging (opt-in): stale at >= 30 days', () => {
  assert.equal(classify({ type: 'bugfix', tier: 'aging', ts: daysAgo(29) }, NOW).stale, false);
  assert.equal(classify({ type: 'bugfix', tier: 'aging', ts: daysAgo(30) }, NOW).stale, true);
  assert.equal(classify({ type: 'bugfix', ts: daysAgo(999) }, NOW).stale, false); // default pinned → never
  assert.equal(THRESHOLD_DAYS.aging, 30);
});

test('perishable: stale at >= 7 days (shorter clock)', () => {
  assert.equal(classify({ type: 'session_summary', ts: daysAgo(6) }, NOW).stale, false);
  assert.equal(classify({ type: 'session_summary', ts: daysAgo(7) }, NOW).stale, true);
  assert.equal(THRESHOLD_DAYS.perishable, 7);
});

test('clock falls back valid_from → ts; lastReinforced wins', () => {
  assert.equal(classify({ type: 'bugfix', tier: 'aging', valid_from: daysAgo(40) }, NOW).stale, true);
  assert.equal(classify({ type: 'bugfix', tier: 'aging', lastReinforced: daysAgo(1), ts: daysAgo(99) }, NOW).stale, false);
});

test('no parseable date → never archived blindly', () => {
  assert.equal(classify({ type: 'session_summary' }, NOW).stale, false);
  assert.equal(classify({ type: 'session_summary', ts: 'not-a-date' }, NOW).stale, false);
});
