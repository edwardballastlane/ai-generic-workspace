#!/usr/bin/env node
/**
 * Value Event Logger
 * Shared utility for hooks to log structured value events.
 * Must be fast (<5ms) since hooks have a 1s timeout.
 *
 * Usage:
 *   const { logValueEvent } = require('./value-logger');
 *   logValueEvent('rule_injection', 5, { categories: ['typescript'], ruleIds: ['abc'] });
 *
 * Event types:
 *   - rule_injection: Rules injected into context
 *   - skill_suggestion: Skills suggested to user
 *   - session_search: Search results returned
 */

const fs = require('fs');
const path = require('path');

// Find workspace root
function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, 'CLAUDE.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Read the current session ID from the active session file.
 * Returns empty string if unavailable.
 */
function getSessionId() {
  try {
    const workspaceRoot = findWorkspaceRoot();
    const sessionFile = path.join(workspaceRoot, '.claude', 'logs', 'sessions', 'active-session.json');
    if (fs.existsSync(sessionFile)) {
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      return data.sessionId || '';
    }
  } catch {}
  return '';
}

/**
 * Log a value event to the JSONL event log.
 * Fails silently on any error to avoid disrupting hooks.
 *
 * @param {string} type - Event type (rule_injection, skill_suggestion, session_search)
 * @param {number} count - Number of items (rules injected, skills suggested, results returned)
 * @param {object} details - Additional event-specific details
 * @param {string} [sessionId] - Live session id (from the hook stdin payload).
 *   When provided it is authoritative; otherwise we fall back to the on-disk
 *   active-session file. Populating this is what lets value-events be joined to
 *   session-end-events (cost/tokens) on session id.
 */
function logValueEvent(type, count, details, sessionId) {
  try {
    const workspaceRoot = findWorkspaceRoot();
    const logDir = path.join(workspaceRoot, '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const logPath = path.join(logDir, 'value-events.jsonl');
    const event = {
      timestamp: new Date().toISOString(),
      sessionId: (typeof sessionId === 'string' && sessionId) ? sessionId : getSessionId(),
      type,
      count,
      details: details || {},
    };

    fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  } catch {
    // Silent failure — hooks must not break
  }
}

module.exports = { logValueEvent };
