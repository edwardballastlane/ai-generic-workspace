'use strict';

/**
 * verify-gate — advisory, deterministic, opt-in verify-before-done
 * (OpenHands critic-gate + Aider auto-test, scoped to Lane's decisions: ADVISORY
 * (never blocks a session), DETERMINISTIC (runs the repo's own test/lint command —
 * no LLM), OPT-IN (active only where a `.lane-verify.json` exists).
 *
 * A repo opts in by adding `.lane-verify.json` at its root:
 *   {
 *     "commands": [ { "name": "tests", "run": "npm test" },
 *                   { "name": "lint",  "run": "npm run lint" } ],
 *     "whenPathsChanged": ["scripts/", "tests/"],   // optional: only run on relevant edits
 *     "timeoutMs": 180000                            // optional per-command cap (default 180s)
 *   }
 *
 * Pure config/decision logic here (unit-tested); the command runner is injected so
 * tests never shell out. The CLI (scripts/verify-gate.js) wires the real runner and
 * records a verifier_verdict; session-stop spawns it in the background so it never
 * delays exit.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 180000;

/** Parse + normalize a config object/text. Returns null when unusable. */
function parseConfig(input) {
  let cfg = input;
  if (typeof input === 'string') {
    try { cfg = JSON.parse(input); } catch { return null; }
  }
  if (!cfg || typeof cfg !== 'object') return null;
  const commands = Array.isArray(cfg.commands)
    ? cfg.commands
        .filter((c) => c && typeof c.run === 'string' && c.run.trim())
        .map((c) => ({ name: String(c.name || c.run).trim(), run: String(c.run).trim() }))
    : [];
  if (commands.length === 0) return null;
  const whenPathsChanged = Array.isArray(cfg.whenPathsChanged)
    ? cfg.whenPathsChanged.map(String) : [];
  const timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  return { commands, whenPathsChanged, timeoutMs };
}

/** Read `.lane-verify.json` at repoRoot, or null if absent/invalid. */
function findConfig(repoRoot) {
  try {
    return parseConfig(fs.readFileSync(path.join(repoRoot, '.lane-verify.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Sentinel for "no file filter was supplied" — a manual `verify-gate` run with no
// --files should run the gate, not skip it. Callers pass [ANY_FILE] in that case.
const ANY_FILE = '__any__';

/**
 * Whether the gate should run given which files changed. With no `whenPathsChanged`
 * filter, or when the caller supplied no file filter at all (ANY_FILE), it runs
 * whenever anything changed; otherwise only when a changed path (made relative to
 * repoRoot) starts with one of the configured prefixes.
 *
 * @param {object} config
 * @param {string[]} filesTouched  absolute or repo-relative paths, or [ANY_FILE]
 * @param {string} repoRoot
 * @returns {boolean}
 */
function shouldRun(config, filesTouched, repoRoot) {
  if (!config || config.commands.length === 0) return false;
  const files = Array.isArray(filesTouched) ? filesTouched : [];
  if (files.length === 0) return false;
  if (files.includes(ANY_FILE)) return true;
  if (config.whenPathsChanged.length === 0) return true;
  const rel = files.map((f) => {
    const r = repoRoot && path.isAbsolute(f) ? path.relative(repoRoot, f) : f;
    return r.split(path.sep).join('/');
  });
  return rel.some((r) => config.whenPathsChanged.some((p) => r.startsWith(p)));
}

/** Reduce command results to a verdict. PASS iff every command exited 0. */
function verdictFrom(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => r.code !== 0);
  return {
    verdict: failed.length === 0 && list.length > 0 ? 'PASS' : 'FAIL',
    ran: list.length,
    failed: failed.map((r) => r.name),
  };
}

/**
 * Run every configured command via an injected runner and return the verdict.
 * `run(command, { cwd, timeoutMs }) => { code, timedOut? }` is injected so this is
 * testable without shelling out.
 *
 * @returns {{verdict:string, ran:number, failed:string[], results:object[]}}
 */
function runGate(repoRoot, config, run) {
  const results = [];
  for (const c of config.commands) {
    let code = 1;
    let timedOut = false;
    try {
      const r = run(c.run, { cwd: repoRoot, timeoutMs: config.timeoutMs }) || {};
      code = Number.isFinite(r.code) ? r.code : (r.status ?? 1);
      timedOut = !!r.timedOut;
    } catch {
      code = 1;
    }
    results.push({ name: c.name, run: c.run, code, timedOut });
  }
  return { ...verdictFrom(results), results };
}

module.exports = {
  parseConfig, findConfig, shouldRun, verdictFrom, runGate, DEFAULT_TIMEOUT_MS, ANY_FILE,
};
