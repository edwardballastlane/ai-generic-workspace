'use strict';

// AI estimate cache, mirrors scripts/_lib/jira-story-points.js's
// spCachePath/loadSpCache/saveSpCache. Written by scripts/set-ai-estimate.js,
// read by scripts/token-dashboard.js. Never reads or writes Jira — this cache
// is Jira-free by design (see docs/specs/spec-2026-07-02-ai-ticket-estimation.md).

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./process');

function aiEstimatesPath(rootDir) {
  return path.join(rootDir, '.ai-memory', 'ai-estimates.json');
}

function loadAiEstimates(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(aiEstimatesPath(rootDir), 'utf8'));
    return { entries: raw.entries || {} };
  } catch { return { entries: {} }; }
}

async function saveAiEstimates(rootDir, cache) {
  const file = aiEstimatesPath(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify(cache, null, 2));
}

module.exports = { aiEstimatesPath, loadAiEstimates, saveAiEstimates };
