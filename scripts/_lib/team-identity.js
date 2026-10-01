'use strict';

// Resolves the three "who" identity spaces the dashboard has to reconcile into a
// single person key (the canonical Jira display name, roster.jira_name):
//   1. session/git usernames  (session-end-events `user`)
//   2. the roster short name   (team-report.md "Name" column)
//   3. Jira assignee names + display-name variants (team-aliases.json)
//
// Framework-free (no DOM) so it is BOTH unit-tested in Node AND embedded verbatim
// into the dashboard client <script> — same single-source pattern as
// delivery-metrics.js. Function declarations only; guarded module.exports below.

// Accent- and case-insensitive normalizer so "David Díaz" ≈ "david diaz" and
// "Jane" matches regardless of casing/whitespace.
function nrm(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// roster:      [{ name, jira_name, session_username, role, allocation }]
// jiraAliases: { jiraDisplayNameVariant -> canonical roster jira_name }
// Returns lookups + resolver helpers keyed by jira_name.
function buildTeamIdentity(roster, jiraAliases) {
  var list = Array.isArray(roster) ? roster : [];
  var aliases = jiraAliases || {};
  var jiraNamesByKey = {};   // jira_name -> Set(canonical + reverse-alias variants)
  var sessionKeyByUser = {}; // nrm(identity string) -> jira_name

  list.forEach(function (r) {
    var variants = new Set([r.jira_name]);
    Object.keys(aliases).forEach(function (k) { if (aliases[k] === r.jira_name) variants.add(k); });
    jiraNamesByKey[r.jira_name] = variants;
    // Any of these identity strings should resolve a session user to this person.
    [r.session_username, r.name, r.jira_name].forEach(function (c) { if (c) sessionKeyByUser[nrm(c)] = r.jira_name; });
    variants.forEach(function (v) { sessionKeyByUser[nrm(v)] = r.jira_name; });
  });

  return {
    jiraNamesByKey: jiraNamesByKey,
    sessionKeyByUser: sessionKeyByUser,
    keys: list.map(function (r) { return r.jira_name; }),
    // session/git user string -> person key ('' if not a roster member).
    personKeyForSessionUser: function (u) { return sessionKeyByUser[nrm(u)] || ''; },
    // person key -> Set of Jira assignee-name variants (for matching delivered tickets).
    jiraNamesForKey: function (key) { return jiraNamesByKey[key] || new Set(key ? [key] : []); },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nrm, buildTeamIdentity };
}
