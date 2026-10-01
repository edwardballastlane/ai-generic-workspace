'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  classifySummary, isNoiseSummary, containsSensitiveData, containsCredential, inferProject, knownProjects,
} = require('../../scripts/_lib/summary-quality');

// A workspace whose sensitive-data policy and registered projects are ours.
function fixtureRoot(policy, projects = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumq-'));
  fs.mkdirSync(path.join(root, '.ai-memory'), { recursive: true });
  if (policy) {
    fs.writeFileSync(path.join(root, '.ai-memory', 'memory-policy.json'), JSON.stringify(policy));
  }
  fs.mkdirSync(path.join(root, 'agent', '_projects'), { recursive: true });
  for (const p of projects) fs.mkdirSync(path.join(root, 'agent', '_projects', p));
  return root;
}

// The finance-domain policy the upstream workspace declares, used here as a
// realistic example of a project-supplied pattern set.
const FINANCE_POLICY = {
  sensitivePatterns: [
    '\\bFO\\d{3,}\\b',
    '\\|\\s*(fund|market value|holdings?|position|cost basis|shares?)\\b',
    '\\bcost basis\\b',
  ],
};

// Real examples pulled from .ai-memory/observations-export/*.jsonl during the
// 2026-08-25 noise audit. Each MUST be rejected with the given reason.
const NOISE = [
  ['prompt-leak', 'You are generating a single git commit message. Return only the commit message'],
  ['prompt-leak', 'You are extracting ACTIONABLE RULES for a developer assistant. Compare the'],
  ['prompt-leak', 'You are a rule validator for a developer assistant. Evaluate this proposal'],
  ['prompt-leak', 'Return only the JSON object, nothing else'],
  ['log-session', 'log session e329a337 (Agustin Fagalde)'],
  ['log-session', 'log session PROJ-901 / log session 5d814b32 (Andy R)'],
  ['bare-ticket', 'PROJ-13690'],          // 10 chars so it clears too-short and hits bare-ticket
  ['too-short', 'PROJ-1369'],             // 9 chars — caught earlier as too-short
  ['followup', 'can you show me this in a table, but drop the position column | Fund | M'],
  ['followup', 'sigamos aca con el ticket 14198, busca la session donde lo estuvimos tra'],
  ['too-short', 'hi'],
  ['too-short', ''],
];

for (const [reason, title] of NOISE) {
  test(`rejects [${reason}]: ${title.slice(0, 40)}`, () => {
    const r = classifySummary({ title });
    assert.equal(r.ok, false, `expected rejection for: ${title}`);
    assert.equal(r.reason, reason);
  });
}

// Real, useful task titles — these MUST pass.
const GOOD = [
  'PROJ-141 Stream reasoning + tool-activity events over SSE (backend agents)',
  'Fix TransactionTransformation error in production consolidated-pricing worker',
  'Add filtering by type and contributor to the Team Memory Board',
  'Investigate cache-key drift RCA for the ToValidate skip path',
  'Harden auth-session refresh-exp check and per-device sid revocation',
];

for (const title of GOOD) {
  test(`accepts: ${title.slice(0, 40)}`, () => {
    const r = classifySummary({ title });
    assert.equal(r.ok, true, `expected acceptance for: ${title} (got ${r.reason})`);
  });
}

test('mid-sentence "you are" is not a prompt leak', () => {
  // Anchored to start — an ordinary task mentioning the phrase survives.
  assert.equal(classifySummary({ title: 'Explain to the user why you are seeing a 504' }).ok, true);
});

test('with no policy declared, domain data is not gated', () => {
  // A generic workspace has no domain to protect; inventing markers would drop
  // legitimate summaries.
  const r = classifySummary({ title: 'Reconcile balances for the client', content: 'Task: FO98765 cash mismatch' });
  assert.equal(r.ok, true);
});

test('isNoiseSummary ignores non-session_summary observations', () => {
  assert.equal(isNoiseSummary({ type: 'bugfix', title: 'x' }), false);
  assert.equal(isNoiseSummary({ type: 'insight', title: 'hi' }), false);
});

test('isNoiseSummary flags a noisy session_summary', () => {
  assert.equal(isNoiseSummary({ type: 'session_summary', title: 'log session abc12345' }), true);
  assert.equal(isNoiseSummary({ type: 'session_summary', title: 'Fix the SSE stream ordering bug' }), false);
});

// --- containsSensitiveData (gates ALL exported types, policy-driven) -----------
test('containsSensitiveData is false when the workspace declares no policy', () => {
  const root = fixtureRoot(null);
  assert.equal(containsSensitiveData({ type: 'bugfix', content: 'wiped tax lots for FO12345' }, root), false);
});

test('containsSensitiveData flags content matching a declared pattern', () => {
  const root = fixtureRoot(FINANCE_POLICY);
  assert.equal(containsSensitiveData({ type: 'bugfix', content: 'wiped tax lots for FO12345' }, root), true);
  assert.equal(containsSensitiveData({ type: 'discovery', content: 'table | Fund | Market value |' }, root), true);
});

test('containsSensitiveData exempts demo/test fixtures by default', () => {
  const root = fixtureRoot(FINANCE_POLICY);
  assert.equal(containsSensitiveData({
    type: 'bugfix',
    content: 'real Tax Advisor account tax+advisor@example.com, FO 925 "Family Demo", adminRights:true',
  }, root), false);
  assert.equal(containsSensitiveData({ type: 'bugfix', content: 'sandbox holdings for FO12345' }, root), false);
});

test('containsSensitiveData honours a custom exempt list', () => {
  const root = fixtureRoot({ ...FINANCE_POLICY, exemptPatterns: ['\\bfixture\\b'] });
  assert.equal(containsSensitiveData({ content: 'FO12345 fixture row' }, root), false);
  assert.equal(containsSensitiveData({ content: 'FO12345 sandbox row' }, root), true);  // default list replaced
});

test('containsSensitiveData ignores an unparseable pattern rather than throwing', () => {
  const root = fixtureRoot({ sensitivePatterns: ['[unclosed', '\\bFO\\d{3,}\\b'] });
  assert.equal(containsSensitiveData({ content: 'FO12345' }, root), true);
});

test('containsSensitiveData is false for ordinary observations', () => {
  const root = fixtureRoot(FINANCE_POLICY);
  assert.equal(containsSensitiveData({ type: 'pattern', title: 'LinkIcon pattern in asset widgets' }, root), false);
});

// --- inferProject / knownProjects ----------------------------------------------
test('knownProjects reads the registered projects, longest slug first', () => {
  const root = fixtureRoot(null, ['api-service', 'api-service-web']);
  assert.deepEqual(knownProjects(root), ['api-service-web', 'api-service']);
});

test('knownProjects is empty when nothing is registered', () => {
  assert.deepEqual(knownProjects(fixtureRoot(null)), []);
});

test('inferProject keeps an existing project', () => {
  const root = fixtureRoot(null, ['api-service']);
  assert.equal(inferProject({ project: 'api-service', content: 'anything' }, root), 'api-service');
});

test('inferProject reads a registered project slug from content', () => {
  const root = fixtureRoot(null, ['web-app']);
  assert.equal(inferProject({ content: 'fix in web-app src/utils/Utils.js' }, root), 'web-app');
});

test('inferProject prefers the longest matching slug', () => {
  const root = fixtureRoot(null, ['api-service', 'api-service-web']);
  assert.equal(inferProject({ content: 'touched api-service-web/src' }, root), 'api-service-web');
});

test('inferProject returns empty when no registered project is mentioned', () => {
  const root = fixtureRoot(null, ['web-app']);
  assert.equal(inferProject({ title: 'some generic task', content: 'no repo named here' }, root), '');
});

// --- Credential gate (always on, never exempted) ---------------------------------
// The export path is fully automatic: mem_save -> exportChunk on Stop -> auto-commit
// -> auto-push to the team remote. A credential must never ride that path, and no
// workspace policy (or absence of one) may waive it.

// Assembled from short fragments at runtime, and deliberately NOT named *_KEY/*_TOKEN,
// so this file trips neither the pre-tool-use guard nor its own detector by accident.
const joinParts = (...parts) => parts.join('');
const probeAwsLike = joinParts('AK', 'IA', '1234567890'.repeat(2).slice(0, 16));
const probeGithubLike = joinParts('gh', 'p_', 'a'.repeat(36));

test('a credential is gated even with NO policy file', () => {
  const root = fixtureRoot(null);
  assert.equal(containsSensitiveData({ title: 'deploy notes', content: probeAwsLike }, root), true);
  assert.equal(containsSensitiveData({ title: 'ci creds', content: probeGithubLike }, root), true);
});

test('exemptPatterns cannot waive a credential', () => {
  // "sandbox" is on the default exempt list; it must not rescue a real-looking value.
  const root = fixtureRoot(FINANCE_POLICY);
  assert.equal(containsSensitiveData({ title: 'sandbox demo', content: probeGithubLike }, root), true);
});

test('the credential gate does not fire on ordinary observations', () => {
  const root = fixtureRoot(null);
  assert.equal(containsSensitiveData({
    title: 'Cache invalidation uses a version key',
    content: 'We bumped a version key instead of deleting entries.',
  }, root), false);
});

test('containsCredential is independent of any workspace policy', () => {
  assert.equal(containsCredential(probeAwsLike), true);
  assert.equal(containsCredential('a perfectly ordinary sentence'), false);
});
