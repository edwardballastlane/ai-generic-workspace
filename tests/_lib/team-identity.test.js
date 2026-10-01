'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nrm, buildTeamIdentity } = require('../../scripts/_lib/team-identity');

// Entirely synthetic roster — fake names. Deliberately exercises the hard cases:
//  - accented Jira name vs plain session name  (Zoë Frontend  / "zoe")
//  - session username differs from Jira name    (session "benjy" → "Ben Backend")
//  - no session username, matched by short name (Cid → "Cid Middle")
//  - a Jira display-name variant via aliases     ("z-front" → "Zoë Frontend")
const ROSTER = [
  { name: 'Zoe', jira_name: 'Zoë Frontend', session_username: 'zoe', role: 'FE', allocation: 1 },
  { name: 'Ben', jira_name: 'Ben Backend', session_username: 'benjy', role: 'BE', allocation: 0.5 },
  { name: 'Cid', jira_name: 'Cid Middle', session_username: '', role: 'BE', allocation: 1 },
];
const ALIASES = { 'z-front': 'Zoë Frontend' };

test('nrm strips accents, lowercases, and collapses whitespace', () => {
  assert.equal(nrm('Zoë  Frontend'), 'zoe frontend');
  assert.equal(nrm('  BEN  '), 'ben');
  assert.equal(nrm(null), '');
});

test('session user resolves to a person by session username, short name, or jira name', () => {
  const id = buildTeamIdentity(ROSTER, ALIASES);
  assert.equal(id.personKeyForSessionUser('zoe'), 'Zoë Frontend');       // session_username
  assert.equal(id.personKeyForSessionUser('benjy'), 'Ben Backend');      // session_username ≠ jira name
  assert.equal(id.personKeyForSessionUser('Ben'), 'Ben Backend');        // short name
  assert.equal(id.personKeyForSessionUser('Cid Middle'), 'Cid Middle');  // jira name (no session username)
  assert.equal(id.personKeyForSessionUser('Cid'), 'Cid Middle');         // short name
});

test('session-user matching is accent- and case-insensitive', () => {
  const id = buildTeamIdentity(ROSTER, ALIASES);
  assert.equal(id.personKeyForSessionUser('Zoe Frontend'), 'Zoë Frontend'); // no accent
  assert.equal(id.personKeyForSessionUser('ZOE'), 'Zoë Frontend');          // different case
});

test('an alias variant resolves both as a session user and as a Jira assignee name', () => {
  const id = buildTeamIdentity(ROSTER, ALIASES);
  assert.equal(id.personKeyForSessionUser('z-front'), 'Zoë Frontend');
  assert.deepEqual([...id.jiraNamesForKey('Zoë Frontend')].sort(), ['Zoë Frontend', 'z-front']);
});

test('unknown / non-roster users resolve to empty', () => {
  const id = buildTeamIdentity(ROSTER, ALIASES);
  assert.equal(id.personKeyForSessionUser('some-bot'), '');
  assert.equal(id.personKeyForSessionUser(''), '');
});

test('jiraNamesForKey falls back to the key itself when not in the roster', () => {
  const id = buildTeamIdentity(ROSTER, ALIASES);
  assert.deepEqual([...id.jiraNamesForKey('Someone Else')], ['Someone Else']);
  assert.deepEqual([...id.jiraNamesForKey('')], []);
});

test('empty roster yields a usable, empty resolver', () => {
  const id = buildTeamIdentity([], {});
  assert.equal(id.personKeyForSessionUser('anyone'), '');
  assert.deepEqual(id.keys, []);
});
