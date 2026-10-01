'use strict';

/**
 * Deadcode ratchet — pure logic.
 *
 * Flags script files that nothing in the repo references (an orphaned file
 * nobody requires, no npm script runs, no command/hook/CI invokes). Like the
 * other ratchets it freezes the current population and fails CI only on GROWTH,
 * so a repo that already carries some orphans can adopt the guard immediately.
 *
 * "Referenced" is intentionally GENEROUS (many signals ⇒ alive) so the failure
 * direction is safe: a genuinely-wired new file won't trip the guard, only a
 * true orphan will. Pure: the CLI builds the file list + haystack and calls in.
 */

const path = require('node:path');

const CODE_EXT = /\.(js|ts|cjs|mjs)$/;

/** Reference tokens derived from a candidate's repo-relative path. */
function referenceTokens(relPath) {
  const posix = relPath.split(path.sep).join('/');
  const base = posix.split('/').pop();
  const baseNoExt = base.replace(CODE_EXT, '');
  return { posix, base, baseNoExt };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `relPath` referenced by the text `haystack`?
 * Signals (any hit ⇒ referenced):
 *  - full posix relpath ("scripts/foo/bar.js") — npm scripts, CI, command docs
 *  - basename with extension ("bar.js")
 *  - basename without extension as a whole word ("bar") — relative requires like
 *    require('../foo/bar'), import ... from './bar'
 */
function isReferencedBy(relPath, haystack) {
  const { posix, base, baseNoExt } = referenceTokens(relPath);
  if (haystack.includes(posix)) return true;
  if (haystack.includes(base)) return true;
  return new RegExp(`\\b${escapeRe(baseNoExt)}\\b`).test(haystack);
}

/**
 * Compute the sorted list of dead (unreferenced) candidate paths.
 *
 * The reference set is a list of {rel, text} SOURCES (not one blob), so a
 * candidate can be referenced by ANOTHER script file (cross-file imports count)
 * while still excluding its OWN file (a file mentioning its own basename doesn't
 * self-rescue). Callers MUST build sources from git-tracked files only, so the
 * result is identical locally and in CI (gitignored session logs/caches that
 * happen to mention a module name must not make it look alive).
 *
 * @param {string[]} candidatePaths - repo-relative code file paths to judge
 * @param {Array<{rel:string,text:string}>|string} sources - reference sources;
 *        a bare string is treated as one anonymous source (back-compat).
 * @returns {string[]} sorted posix relpaths that are unreferenced
 */
function computeDead(candidatePaths, sources) {
  const srcList = Array.isArray(sources)
    ? sources
    : [{ rel: '<anon>', text: String(sources || '') }];
  const dead = [];
  for (const cand of candidatePaths || []) {
    const posix = cand.split(path.sep).join('/');
    let referenced = false;
    for (const s of srcList) {
      if (s.rel === posix) continue; // self-exclusion
      if (isReferencedBy(posix, s.text)) { referenced = true; break; }
    }
    if (!referenced) dead.push(posix);
  }
  return dead.sort();
}

module.exports = { CODE_EXT, referenceTokens, isReferencedBy, computeDead };
