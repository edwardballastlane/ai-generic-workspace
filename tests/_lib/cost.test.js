'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCostUsd } = require('../../scripts/_lib/cost');

test('Opus 4.7 pricing matches statusline awk math', () => {
  // 1M input @ $5, 1M output @ $25 → $30 total
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 30);
});

test('Opus 4.8 uses current 5/25 rate (regression: must not fall through to Sonnet)', () => {
  // 1M input @ $5, 1M output @ $25 → $30 total. Before the numeric-minor fix,
  // claude-opus-4-8 missed the /opus-4-(5|6|7)/ regex and was billed as Sonnet ($18).
  const cost = computeCostUsd('claude-opus-4-8', {
    input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 30);
});

test('Opus 5 uses 5/25 rate (regression: must not fall through to Sonnet)', () => {
  // 1M input @ $5, 1M output @ $25 → $30 total. claude-opus-5 (and the [1m]
  // context variant) matches none of the opus-4/opus-3 patterns, so without an
  // explicit opus-5 branch it was billed at the Sonnet default ($18).
  for (const model of ['claude-opus-5', 'claude-opus-5[1m]']) {
    const cost = computeCostUsd(model, {
      input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0
    });
    assert.equal(cost, 30);
  }
});

test('Fable 5 uses 10/50 rate (regression: must not fall through to Sonnet)', () => {
  // 1M input @ $10, 1M output @ $50 → $60 total. Without an explicit fable
  // branch in priceFor, claude-fable-5 would fall through to the Sonnet
  // default ($18) and under-report cost for the most expensive tier.
  const cost = computeCostUsd('claude-fable-5', {
    input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 60);
});

test('Mythos 5 prices identically to Fable 5', () => {
  const cost = computeCostUsd('claude-mythos-5', {
    input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 60);
});

test('Fable 5 1h cache write priced at $20/M (2x input)', () => {
  const cost = computeCostUsd('claude-fable-5', {
    input: 0, output: 0, cacheCreation5m: 0, cacheCreation1h: 1_000_000, cacheRead: 0
  });
  assert.equal(cost, 20);
});

test('Opus 4.0 uses legacy 15/75 rate', () => {
  const cost = computeCostUsd('claude-opus-4', {
    input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 15);
});

test('Sonnet 4 default for unknown models', () => {
  const cost = computeCostUsd('claude-future-model-9', {
    input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 3);
});

test('cache reads cost less than fresh input', () => {
  // Opus 4.7: cache_read = $0.50/M
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000
  });
  assert.ok(Math.abs(cost - 0.50) < 0.001, `expected ~0.50, got ${cost}`);
});

test('Haiku 3 deprecated rate', () => {
  const cost = computeCostUsd('claude-haiku-3', {
    input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 0.25 + 1.25);
});

test('zero tokens → zero cost regardless of model', () => {
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 0, output: 0, cacheCreation: 0, cacheRead: 0
  });
  assert.equal(cost, 0);
});

test('Opus 4.7: 1M cache write at 5m TTL costs $6.25 (legacy aggregate path)', () => {
  // Backward compat: rows recorded before the 5m/1h split was tracked carry
  // only `cacheCreation`. Those are priced at the 5m rate.
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 0, output: 0, cacheCreation: 1_000_000, cacheRead: 0
  });
  assert.equal(cost, 6.25);
});

test('Opus 4.7: 1M cache write at 1h TTL costs $10 (1.6x the 5m rate)', () => {
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 0, output: 0, cacheCreation5m: 0, cacheCreation1h: 1_000_000, cacheRead: 0
  });
  assert.equal(cost, 10);
});

test('Opus 4.7: split 5m + 1h cache writes are priced at correct rates', () => {
  // 500k 5m × $6.25/M + 500k 1h × $10/M = 3.125 + 5 = 8.125
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 0, output: 0,
    cacheCreation5m: 500_000, cacheCreation1h: 500_000,
    cacheRead: 0
  });
  assert.equal(cost, 8.125);
});

test('Sonnet 4 1h cache write priced at $6/M (1.6x of $3.75 5m)', () => {
  const cost = computeCostUsd('claude-sonnet-4-6', {
    input: 0, output: 0, cacheCreation5m: 0, cacheCreation1h: 1_000_000, cacheRead: 0
  });
  assert.equal(cost, 6);
});

test('Haiku 4 1h cache write priced at $2/M (1.6x of $1.25 5m)', () => {
  const cost = computeCostUsd('claude-haiku-4-5', {
    input: 0, output: 0, cacheCreation5m: 0, cacheCreation1h: 1_000_000, cacheRead: 0
  });
  assert.equal(cost, 2);
});

test('5m/1h split takes precedence over legacy cacheCreation when both present', () => {
  // If new fields are nonzero, ignore the legacy aggregate to avoid double-count.
  const cost = computeCostUsd('claude-opus-4-7', {
    input: 0, output: 0,
    cacheCreation: 9_999_999,            // would dominate if used
    cacheCreation5m: 0, cacheCreation1h: 1_000_000,  // these win
    cacheRead: 0
  });
  assert.equal(cost, 10, 'split fields should win, not the aggregate');
});
