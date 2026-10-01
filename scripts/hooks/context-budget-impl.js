/**
 * Context Budget — impl module.
 *
 * Tracks prompt count per session and emits a stale-context warning at
 * configurable thresholds. Called in-process by user-prompt-dispatcher.js
 * and via the backwards-compat thin shim scripts/hooks/context-budget.js.
 *
 * Pure: reads / writes .ai-session/prompt-count, returns the output string.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOFT_WARNING_INTERVAL = 30;
const HARD_WARNING_THRESHOLD = 50;

function readCounter(counterFile) {
  try {
    const raw = fs.readFileSync(counterFile, 'utf8').trim();
    const lines = raw.split('\n');
    if (lines.length >= 2) return { storedSessionId: lines[0], count: parseInt(lines[1], 10) || 0 };
    return { storedSessionId: '', count: parseInt(lines[0], 10) || 0 };
  } catch {
    return { storedSessionId: '', count: 0 };
  }
}

function writeCounter(counterFile, sessionId, count) {
  try {
    const data = sessionId ? `${sessionId}\n${count}` : `${count}`;
    fs.writeFileSync(counterFile, data, 'utf8');
  } catch {
    /* silent — don't break the hook chain */
  }
}

function run({ sessionId, workspaceRoot }) {
  const sessionDir = path.join(workspaceRoot, '.ai-session');
  try {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  } catch {
    return '';
  }

  const counterFile = path.join(sessionDir, 'prompt-count');
  let { storedSessionId, count } = readCounter(counterFile);

  if (sessionId && storedSessionId && sessionId !== storedSessionId) count = 0;
  count++;
  writeCounter(counterFile, sessionId, count);

  if (count >= HARD_WARNING_THRESHOLD && count % 10 === 0) {
    return (
      `[Context budget: ~${count} prompts] ` +
      'Context window is heavily used. ' +
      'Strongly consider running ./scripts/fresh-context and starting a new session to maintain AI quality.'
    );
  }
  if (count > 0 && count % SOFT_WARNING_INTERVAL === 0) {
    return (
      `[Context budget: ~${count} prompts] ` +
      'Consider running ./scripts/fresh-context to start fresh'
    );
  }
  return '';
}

module.exports = { run };
