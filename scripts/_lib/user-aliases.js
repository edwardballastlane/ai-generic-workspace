'use strict';

/**
 * Canonicalize the `user` field on session events.
 *
 * `session-stop` records `user` verbatim from `git config user.name`, so one
 * person with inconsistent git config across repos/machines surfaces as several
 * distinct users in the dashboard (e.g. "jdoe91" vs "Jane Doe"). The alias
 * map in .ai-memory/user-aliases.json folds those variants onto a canonical
 * name. Loaded once, cached, and applied at read time by consumers.
 */

const fs = require('node:fs');
const path = require('node:path');

const ALIASES_NAME = 'user-aliases.json';

function aliasesPath(root) {
  return path.join(root, '.ai-memory', ALIASES_NAME);
}

/**
 * Load the {variant -> canonical} alias map for a workspace root.
 * Missing/malformed file → empty map (no-op normalization).
 * @param {string} root
 * @returns {Record<string,string>}
 */
function loadUserAliases(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(aliasesPath(root), 'utf8'));
    const aliases = raw && raw.aliases;
    return aliases && typeof aliases === 'object' ? aliases : {};
  } catch {
    return {};
  }
}

/**
 * Map a raw user name to its canonical form via the supplied alias map.
 * Unknown names pass through unchanged.
 * @param {string} user
 * @param {Record<string,string>} aliases
 * @returns {string}
 */
function canonicalUser(user, aliases) {
  if (!user) return user;
  return (aliases && aliases[user]) || user;
}

module.exports = { ALIASES_NAME, aliasesPath, loadUserAliases, canonicalUser };
