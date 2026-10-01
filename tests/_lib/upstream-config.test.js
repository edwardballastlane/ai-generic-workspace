'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, '.ai-config', 'upstream.example.json');

// projectTerms is a list of the customer, product and vendor names this
// workspace must never ship — so committing the real list would publish exactly
// the vocabulary the gate exists to keep out. The scanner cannot catch this
// itself: a terms file always contains its own terms, so it is in `ignore`.
// This test is that guard.
const PLACEHOLDERS = new Set(['acmecorp', '/\\bACME\\b/g', '\\bwidgetflow\\b']);

test('the committed template declares itself a placeholder', () => {
  const cfg = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  assert.equal(cfg.placeholder, true, 'placeholder:true is what makes drift:scan disclaim its result');
});

test('the committed template carries no real project vocabulary', () => {
  const cfg = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const leaked = (cfg.projectTerms || []).filter((t) => !PLACEHOLDERS.has(t));
  assert.deepEqual(leaked, [], `real terms must live only in the gitignored .ai-config/upstream.json, not here`);
});

test('the template ships no upstream path', () => {
  const cfg = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  assert.equal(cfg.upstream.path, '', 'the upstream path is machine-specific and stays local');
});
