'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { detectProject } = require('../../scripts/hooks/inject-rules-impl');

const VALID_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_SID = '11111111-2222-3333-4444-555555555555';

async function setupRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'inject-rules-'));
  await fsp.mkdir(path.join(root, '.ai-session'), { recursive: true });
  await fsp.mkdir(path.join(root, 'agent', '_projects'), { recursive: true });
  return root;
}

test('AC-3 (Phase A): detected-project cached by another session is NOT returned by inject-rules detectProject', async () => {
  // Mirrors the inject-context.test.js AC-2 case for the inject-rules side.
  // Per spec docs/specs/spec-2026-05-15-per-cc-session-binding.md AC-3, both
  // hooks must independently honor the session_id gate.
  const root = await setupRoot();
  try {
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-portal-web'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.ai-session', 'detected-project'),
      `${OTHER_SID}\nmy-portal-web\n`,
    );
    // VALID_SID with no other project signal: empty cwd, prompt unrelated.
    const project = detectProject(root, '/tmp/unrelated', 'unrelated question', VALID_SID);
    assert.notEqual(project, 'my-portal-web', 'must not inherit OTHER_SID cached project');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-3 (Phase A): detected-project cached by the same session IS returned by inject-rules detectProject', async () => {
  const root = await setupRoot();
  try {
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-backend'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.ai-session', 'detected-project'),
      `${VALID_SID}\nmy-backend\n`,
    );
    // No other signal — must come from the gated cache.
    const project = detectProject(root, '/tmp/unrelated', 'unrelated question', VALID_SID);
    assert.equal(project, 'my-backend', 'must see own cached project');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC-3 (Phase A): legacy 1-line detected-project file is ignored by inject-rules detectProject', async () => {
  const root = await setupRoot();
  try {
    await fsp.mkdir(path.join(root, 'agent', '_projects', 'my-portal-web'), { recursive: true });
    // Legacy format: project slug only, no session_id line.
    await fsp.writeFile(path.join(root, '.ai-session', 'detected-project'), 'my-portal-web\n');
    const project = detectProject(root, '/tmp/unrelated', 'unrelated question', VALID_SID);
    assert.notEqual(project, 'my-portal-web', 'legacy 1-line file must NOT be honored');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- Lane-memory observation injection (opt-in) ---------------------------------

const { run, tokenize, scoreObservations } = require('../../scripts/hooks/inject-rules-impl');

const OBSERVATIONS = [
  {
    id: 'o1', type: 'decision', title: 'Cache invalidation uses a version key',
    content: 'We bumped a version key instead of deleting entries, because deletes raced with warmers.',
    tags: ['cache'], source: 'agent', scope: 'project', ts: '2026-09-01T00:00:00Z',
  },
  {
    id: 'o2', type: 'bugfix', title: 'Unrelated topic about pastry dough',
    content: 'Nothing to do with the prompt.',
    tags: [], source: 'agent', scope: 'project', ts: '2026-09-01T00:00:00Z',
  },
  {
    // Near-identical text to o1, but already injected as a rule — must be excluded
    // so the prompt never carries the same context twice.
    id: 'o3', type: 'pattern', title: 'Excluded because it came from rules',
    content: 'cache invalidation version key deletes warmers entries bumped',
    tags: [], source: 'rules-shared', scope: 'project', ts: '2026-09-01T00:00:00Z',
  },
];

const OBS_PROMPT = 'how does cache invalidation version key work';

async function setupObsRoot(observations = OBSERVATIONS) {
  const root = await setupRoot();
  await fsp.mkdir(path.join(root, '.ai-memory', 'observations'), { recursive: true });
  await fsp.writeFile(
    path.join(root, '.ai-memory', 'observations', 'project.jsonl'),
    observations.map((o) => JSON.stringify(o)).join('\n') + '\n',
  );
  // run() bails before ever reaching observations when there are no rules.
  await fsp.mkdir(path.join(root, 'scripts', 'self-improvement'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'scripts', 'self-improvement', 'rules.json'),
    JSON.stringify([{ id: 'R1', status: 'active', text: 'Prefer early returns.', categories: ['general'], score: 5 }]),
  );
  return root;
}

function runWithObs(root, enabled) {
  const prev = process.env.LANE_INJECT_MEMORY_OBS;
  if (enabled) process.env.LANE_INJECT_MEMORY_OBS = '1';
  else delete process.env.LANE_INJECT_MEMORY_OBS;
  try {
    return run({ prompt: OBS_PROMPT, cwd: root, sessionId: '', workspaceRoot: root });
  } finally {
    if (prev === undefined) delete process.env.LANE_INJECT_MEMORY_OBS;
    else process.env.LANE_INJECT_MEMORY_OBS = prev;
  }
}

test('scoreObservations ranks by overlap, drops zero-overlap, and ignores source', () => {
  const promptSet = new Set(tokenize(OBS_PROMPT));
  const scored = scoreObservations(OBSERVATIONS, promptSet);

  assert.equal(scored.every((s) => s.score > 0), true, 'zero-overlap entries are dropped');
  assert.equal(scored.some((s) => s.obs.id === 'o2'), false, 'the pastry observation shares no terms');
  // Descending by score.
  for (let i = 1; i < scored.length; i += 1) {
    assert.equal(scored[i - 1].score >= scored[i].score, true);
  }
  // The scorer is source-blind on purpose — run() does the rules-shared exclusion,
  // so a denser rules-sourced match can legitimately outrank an agent one here.
  assert.equal(scored.some((s) => s.obs.id === 'o3'), true);
});

test('scoreObservations tolerates a null/empty list', () => {
  assert.deepEqual(scoreObservations(null, new Set(['x'])), []);
  assert.deepEqual(scoreObservations([null], new Set(['x'])), []);
});

test('observations are NOT injected unless LANE_INJECT_MEMORY_OBS=1', async () => {
  const root = await setupObsRoot();
  try {
    const out = runWithObs(root, false);
    assert.equal(out.includes('memory observation'), false, 'off by default');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('opt-in surfaces the relevant observation with trust framing', async () => {
  const root = await setupObsRoot();
  try {
    const out = runWithObs(root, true);
    assert.match(out, /memory observation\(s\) surfaced/);
    assert.match(out, /not operator instructions/, 'framed as context, not orders');
    assert.match(out, /\[decision\] Cache invalidation uses a version key/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('opt-in excludes rules-shared/MEMORY.md sources and weak matches', async () => {
  const root = await setupObsRoot();
  try {
    const out = runWithObs(root, true);
    assert.equal(out.includes('Excluded because it came from rules'), false,
      'rules-shared is already injected as a rule — never duplicated here');
    assert.equal(out.includes('pastry dough'), false, 'below the score floor');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('opt-in with an unreadable store never breaks rule injection', async () => {
  const root = await setupObsRoot([]);
  try {
    await fsp.rm(path.join(root, '.ai-memory'), { recursive: true, force: true });
    // A rule that actually matches the prompt, so "rules still surface" is testable.
    await fsp.writeFile(
      path.join(root, 'scripts', 'self-improvement', 'rules.json'),
      JSON.stringify([{ id: 'R2', status: 'active', text: 'Invalidate the cache by bumping a version key.', categories: ['general'], score: 5 }]),
    );
    const out = runWithObs(root, true);
    assert.equal(out.includes('memory observation'), false);
    assert.match(out, /rules injected/, 'rules still surface');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
