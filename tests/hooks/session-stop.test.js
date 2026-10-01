'use strict';

// Test fixtures use PROJ-* Jira keys; set the prefix before subprocess spawn.
process.env.JIRA_PREFIX = 'PROJ'; // fixtures hardcode PROJ-; do not defer to the ambient value

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const { readAllLines } = require('../../scripts/_lib/session-events')

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-stop.js')
const FIXTURE_TRANSCRIPT = path.join(__dirname, '..', 'fixtures', 'transcript-min.jsonl')
const FIXTURE_SIDECAR = path.join(__dirname, '..', 'fixtures', 'sidecar-min.json')

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-'))
  await fs.mkdir(path.join(root, '.ai-memory'), { recursive: true })
  await fs.mkdir(path.join(root, '.ai-session', 'by-id'), { recursive: true })
  // Not initialized as a git repo — auto-commit branch must be a no-op.
  return root
}

function runHook(root, hookInput) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: JSON.stringify(hookInput),
    encoding: 'utf8',
    env: { ...process.env, MEMORY_SYNC_ENABLED: '0' }
  })
}

test('writes a session_end event with token totals + computed cost', async () => {
  const root = await setupRoot()
  try {
    const r = runHook(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)
    const lines = readAllLines(root) // legacy + monthly shards
    assert.equal(lines.length, 1)
    const ev = JSON.parse(lines[0])
    assert.equal(ev.type, 'session_end')
    assert.equal(ev.input_tokens, 300)
    assert.equal(ev.output_tokens, 230)
    assert.equal(ev.cache_read_tokens, 5000)
    assert.equal(ev.cache_creation_tokens, 50)
    assert.ok(ev.cost_usd > 0)
    assert.equal(ev.model, 'claude-opus-4-7') // persisted for by-model attribution
    assert.match(ev.task || '', /PROJ-123/) // fallback when sidecar missing
    // No git history in tempdir + no resume note → ticket signal wins.
    assert.equal(ev.task_source, 'ticket')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('defaults ai_estimated to null in the no-sidecar fallback path', async () => {
  const root = await setupRoot()
  try {
    const r = runHook(root, {
      session_id: '99999999-aaaa-bbbb-cccc-dddddddddddd',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)
    const lines = readAllLines(root)
    const ev = JSON.parse(lines[lines.length - 1])
    assert.equal(ev.ai_estimated, null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('merges sidecar fields when sidecar exists', async () => {
  const root = await setupRoot()
  try {
    const sidecar = await fs.readFile(FIXTURE_SIDECAR, 'utf8')
    const sidecarPath = path.join(
      root, '.ai-session', 'by-id',
      '11111111-2222-3333-4444-555555555555.json'
    )
    await fs.writeFile(sidecarPath, sidecar)

    const r = runHook(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    const lines = readAllLines(root)
    const ev = JSON.parse(lines[lines.length - 1])
    assert.equal(ev.project, 'my-backend')
    assert.equal(ev.prompts, 7)
    assert.equal(ev.duration_ms, 123456)
    assert.equal(ev.lines_added, 12)
    assert.ok(ev.cost_usd > 0) // backfilled because sidecar had 0
    // Sidecar.task is empty, so taskFb is used. Sidecar has no started_at/last_active
    // (git skipped) and no resume note → ticket signal from PROJ-123 in transcript.
    assert.equal(ev.task_source, 'ticket')

    // Sidecar must be backfilled with token totals + cost (atomicWrite path).
    const updated = JSON.parse(await fs.readFile(sidecarPath, 'utf8'))
    assert.equal(updated.input_tokens, 300)
    assert.equal(updated.output_tokens, 230)
    assert.ok(updated.cost_usd > 0, `expected backfilled cost_usd > 0, got ${updated.cost_usd}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('passes through sidecar ai_estimated field into the event', async () => {
  const root = await setupRoot()
  try {
    const sidecar = {
      session_id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
      project: 'my-backend',
      task: '', jira_ticket: '',
      prompts: 2, cost_usd: 0, duration_ms: 1000,
      lines_added: 0, lines_removed: 0,
      ai_estimated: 3
    }
    await fs.writeFile(
      path.join(root, '.ai-session', 'by-id', `${sidecar.session_id}.json`),
      JSON.stringify(sidecar)
    )

    const r = runHook(root, {
      session_id: sidecar.session_id,
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    const lines = readAllLines(root)
    const ev = JSON.parse(lines[lines.length - 1])
    assert.equal(ev.ai_estimated, 3)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('defaults ai_estimated to null when sidecar omits the field', async () => {
  const root = await setupRoot()
  try {
    // FIXTURE_SIDECAR (sidecar-min.json) has no ai_estimated key.
    const sidecar = await fs.readFile(FIXTURE_SIDECAR, 'utf8')
    const sidecarPath = path.join(
      root, '.ai-session', 'by-id',
      '11111111-2222-3333-4444-555555555555.json'
    )
    await fs.writeFile(sidecarPath, sidecar)

    const r = runHook(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    const lines = readAllLines(root)
    const ev = JSON.parse(lines[lines.length - 1])
    assert.equal(ev.ai_estimated, null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exits 0 even with empty stdin', async () => {
  const root = await setupRoot()
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, MEMORY_SYNC_ENABLED: '0' }
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)
    // With empty stdin no signals fire — task_source is the empty string.
    const lines = readAllLines(root)
    if (lines.length > 0) {
      const ev = JSON.parse(lines[lines.length - 1])
      assert.equal(ev.task_source, '')
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('uses git-commit signal when session window has commits', async () => {
  const root = await setupRoot()
  try {
    const { execFileSync } = require('node:child_process')
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }
    execFileSync('git', ['init', '-q'], opts)
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
    execFileSync('git', ['config', 'user.name', 'Test'], opts)
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)
    await fs.writeFile(path.join(root, 'a.txt'), 'x')
    execFileSync('git', ['add', '-A'], opts)
    execFileSync('git', ['commit', '-q', '-m', 'feat: add new endpoint'], opts)

    const sidecar = {
      session_id: '22222222-3333-4444-5555-666666666666',
      project: 'my-backend',
      task: '', jira_ticket: '',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_active: new Date(Date.now() + 60_000).toISOString(),
      prompts: 1, cost_usd: 0, duration_ms: 1, lines_added: 0, lines_removed: 0
    }
    await fs.writeFile(
      path.join(root, '.ai-session', 'by-id', `${sidecar.session_id}.json`),
      JSON.stringify(sidecar)
    )
    const r = runHook(root, {
      session_id: sidecar.session_id,
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)
    const lines = readAllLines(root)
    const ev = JSON.parse(lines[lines.length - 1])
    assert.equal(ev.task_source, 'commit')
    assert.match(ev.task, /add new endpoint/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('auto-commit includes .claude/logs/value-events.jsonl when present', async () => {
  const root = await setupRoot()
  try {
    const { execFileSync } = require('node:child_process')
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }
    execFileSync('git', ['init', '-q'], opts)
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
    execFileSync('git', ['config', 'user.name', 'Test'], opts)
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)

    // Value-events log written by the per-prompt value logger this session.
    await fs.mkdir(path.join(root, '.claude', 'logs'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.claude', 'logs', 'value-events.jsonl'),
      JSON.stringify({ sessionId: '', timestamp: '2026-06-24T00:00:00Z', type: 'rule_injection' }) + '\n'
    )

    const r = runHook(root, {
      session_id: '33333333-4444-5555-6666-777777777777',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    // The session-log auto-commit must include the value-events log alongside
    // the session-end shard (regression: it was previously left uncommitted).
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'],
      { cwd: root, encoding: 'utf8' })
    assert.match(committed, /\.claude\/logs\/value-events\.jsonl/,
      `value-events.jsonl must be in the auto-commit; committed files:\n${committed}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('auto-commit includes .ai-memory/ai-estimates.json when present', async () => {
  const root = await setupRoot()
  try {
    const { execFileSync } = require('node:child_process')
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }
    execFileSync('git', ['init', '-q'], opts)
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
    execFileSync('git', ['config', 'user.name', 'Test'], opts)
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)

    // AI-estimates cache written by set-ai-estimate.js earlier this session.
    await fs.writeFile(
      path.join(root, '.ai-memory', 'ai-estimates.json'),
      JSON.stringify({
        entries: {
          'PROJ-1234': { ai_sp: 3, basis: 'create', estimator: 'claude-opus-4-8', estimated_at: '2026-07-02T00:00:00.000Z' }
        }
      })
    )

    const r = runHook(root, {
      session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    // The session-log auto-commit must include the AI-estimates cache alongside
    // the session-end shard (mirrors the value-events.jsonl staging assertion above).
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'],
      { cwd: root, encoding: 'utf8' })
    assert.match(committed, /\.ai-memory\/ai-estimates\.json/,
      `ai-estimates.json must be in the auto-commit; committed files:\n${committed}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('auto-commit still succeeds when .ai-memory/ai-estimates.json is absent', async () => {
  const root = await setupRoot()
  try {
    const { execFileSync } = require('node:child_process')
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }
    execFileSync('git', ['init', '-q'], opts)
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
    execFileSync('git', ['config', 'user.name', 'Test'], opts)
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)

    // No .ai-memory/ai-estimates.json written this session — "stage only what
    // exists" must not block the commit of the session-end shard.
    const r = runHook(root, {
      session_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'],
      { cwd: root, encoding: 'utf8' })
    assert.doesNotMatch(committed, /\.ai-memory\/ai-estimates\.json/)
    assert.match(committed, /\.ai-memory\/session-end/,
      `session-end shard must still be committed; committed files:\n${committed}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('LANE_EVENTS_ROOT redirects the event to the canonical root, not cwd', async () => {
  const cwdRoot = await setupRoot()
  const eventsRoot = await setupRoot()
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: cwdRoot,
      input: JSON.stringify({ session_id: '66666666-7777-8888-9999-aaaaaaaaaaaa', transcript_path: FIXTURE_TRANSCRIPT }),
      encoding: 'utf8',
      env: { ...process.env, MEMORY_SYNC_ENABLED: '0', LANE_EVENTS_ROOT: eventsRoot }
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)
    // Event lands in the canonical root...
    assert.equal(readAllLines(eventsRoot).length, 1, 'event should be written under LANE_EVENTS_ROOT')
    // ...and NOT in the session's cwd.
    assert.equal(readAllLines(cwdRoot).length, 0, 'event must not be written to cwd when redirected')
  } finally {
    await fs.rm(cwdRoot, { recursive: true, force: true })
    await fs.rm(eventsRoot, { recursive: true, force: true })
  }
})

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// Initialize `root` as a git repo with a bare upstream and one shared commit, so
// the working repo and remote start in sync with an upstream configured. Returns
// the bare-remote path and the current branch name.
async function setupRepoWithRemote(root) {
  const { execFileSync } = require('node:child_process')
  const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-remote-'))
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: opts.stdio })
  execFileSync('git', ['init', '-q'], opts)
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
  execFileSync('git', ['config', 'user.name', 'Test'], opts)
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)
  await fs.writeFile(path.join(root, 'README'), 'x')
  execFileSync('git', ['add', '-A'], opts)
  execFileSync('git', ['commit', '-q', '-m', 'init'], opts)
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  execFileSync('git', ['remote', 'add', 'origin', bare], opts)
  execFileSync('git', ['push', '-q', '-u', 'origin', branch], opts)
  return { bare, branch }
}

test('auto-push: a session-log commit is pushed to the upstream', async () => {
  const root = await setupRoot()
  let bare
  try {
    const { execFileSync } = require('node:child_process')
    ;({ bare } = await setupRepoWithRemote(root))

    const r = runHook(root, {
      session_id: '44444444-5555-6666-7777-888888888888',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    // The push is detached/best-effort, so it may land just after the hook exits — poll.
    let remoteHead = ''
    for (let i = 0; i < 40; i++) {
      remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      if (remoteHead === localHead) break
      await sleep(100)
    }
    assert.equal(remoteHead, localHead, 'session-log commit should reach the upstream via auto-push')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    if (bare) await fs.rm(bare, { recursive: true, force: true })
  }
})

test('auto-push: SESSION_AUTOPUSH=0 leaves the upstream untouched', async () => {
  const root = await setupRoot()
  let bare
  try {
    const { execFileSync } = require('node:child_process')
    let branch
    ;({ bare, branch } = await setupRepoWithRemote(root))
    const remoteBefore = execFileSync('git', ['--git-dir', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim()

    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: '55555555-6666-7777-8888-999999999999', transcript_path: FIXTURE_TRANSCRIPT }),
      encoding: 'utf8',
      env: { ...process.env, MEMORY_SYNC_ENABLED: '0', SESSION_AUTOPUSH: '0' }
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    await sleep(400) // give any (erroneous) push time to land before asserting it didn't
    const remoteAfter = execFileSync('git', ['--git-dir', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim()
    assert.equal(remoteAfter, remoteBefore, 'upstream must not advance when auto-push is disabled')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    if (bare) await fs.rm(bare, { recursive: true, force: true })
  }
})

test('auto-push: rebases and pushes when remote is ahead', async () => {
  const root = await setupRoot()
  let bare
  try {
    const { execFileSync } = require('node:child_process')
    let branch
    ;({ bare, branch } = await setupRepoWithRemote(root))
    const silentOpts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }

    // Simulate another terminal pushing a commit directly to the bare remote.
    const otherClone = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-other-'))
    try {
      const otherOpts = { cwd: otherClone, stdio: ['ignore', 'ignore', 'ignore'] }
      execFileSync('git', ['clone', '-q', bare, '.'], otherOpts)
      execFileSync('git', ['config', 'user.email', 'other@example.com'], otherOpts)
      execFileSync('git', ['config', 'user.name', 'Other'], otherOpts)
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], otherOpts)
      await fs.writeFile(path.join(otherClone, 'other.txt'), 'from other terminal')
      execFileSync('git', ['add', 'other.txt'], otherOpts)
      execFileSync('git', ['commit', '-q', '-m', 'chore: other terminal commit'], otherOpts)
      execFileSync('git', ['push', '-q'], otherOpts)
    } finally {
      await fs.rm(otherClone, { recursive: true, force: true })
    }

    // Local clone is now behind the remote — hook must rebase + push successfully.
    const r = runHook(root, {
      session_id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    // Poll until the local commit reaches the remote (push is synchronous now but
    // we keep the poll for robustness against any timing edge).
    const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    let remoteHead = ''
    for (let i = 0; i < 40; i++) {
      remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      if (remoteHead === localHead) break
      await sleep(100)
    }
    assert.equal(remoteHead, localHead, 'local commit must reach remote even when remote was ahead')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    if (bare) await fs.rm(bare, { recursive: true, force: true })
  }
})

test('auto-push: a conflicting pull --rebase is aborted, never left in progress', async () => {
  const root = await setupRoot()
  let bare
  try {
    const { execFileSync } = require('node:child_process')
    ;({ bare } = await setupRepoWithRemote(root))
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }

    // Remote edits README one way...
    const otherClone = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-conflict-'))
    try {
      const otherOpts = { cwd: otherClone, stdio: ['ignore', 'ignore', 'ignore'] }
      execFileSync('git', ['clone', '-q', bare, '.'], otherOpts)
      execFileSync('git', ['config', 'user.email', 'other@example.com'], otherOpts)
      execFileSync('git', ['config', 'user.name', 'Other'], otherOpts)
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], otherOpts)
      await fs.writeFile(path.join(otherClone, 'README'), 'remote-side\n')
      execFileSync('git', ['commit', '-q', '-am', 'chore: remote edits README'], otherOpts)
      execFileSync('git', ['push', '-q'], otherOpts)
    } finally {
      await fs.rm(otherClone, { recursive: true, force: true })
    }

    // ...and the local clone edits the same line the other way, so replaying the
    // local commit onto the remote tip cannot merge cleanly.
    await fs.writeFile(path.join(root, 'README'), 'local-side\n')
    execFileSync('git', ['commit', '-q', '-am', 'chore: local edits README'], opts)
    const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

    const r = runHook(root, {
      session_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      transcript_path: FIXTURE_TRANSCRIPT
    })
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`)

    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim()
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      assert.equal(existsSync(path.join(root, gitDir, dir)), false,
        `${dir} must not survive a conflicting pull --rebase`)
    }

    // HEAD must be back on the branch, not detached mid-rebase, and the local
    // commit must still be reachable from it.
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(head, branch, 'HEAD must be reattached to the branch')
    const contains = spawnSync('git', ['merge-base', '--is-ancestor', localCommit, 'HEAD'], { cwd: root })
    assert.equal(contains.status, 0, 'the local commit must survive the aborted rebase')

    // And no conflicted paths are handed to the next session.
    const unmerged = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'],
      { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(unmerged, '', `working tree must be conflict-free, got: ${unmerged}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    if (bare) await fs.rm(bare, { recursive: true, force: true })
  }
})

// --- Fallback session memory (memory-store wiring) ------------------------------

// A transcript whose first user turn is a real, descriptive task — the fixture
// transcript derives to a bare ticket key, which the noise gate rejects by design.
async function writeTaskTranscript(root, prompt) {
  const p = path.join(root, 'task.jsonl')
  await fs.writeFile(p, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: prompt }
  }) + '\n')
  return p
}

async function readObservations(root) {
  try {
    const text = await fs.readFile(
      path.join(root, '.ai-memory', 'observations', 'project.jsonl'), 'utf8')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

test('writes a fallback session_summary observation for a real task', async () => {
  const root = await setupRoot()
  try {
    const transcript = await writeTaskTranscript(root, 'Refactor the login flow to use the shared session guard')
    const r = runHook(root, { session_id: 'mem-0001', transcript_path: transcript, cwd: root })
    assert.equal(r.status, 0)

    const obs = await readObservations(root)
    const summaries = obs.filter((o) => o.type === 'session_summary')
    assert.equal(summaries.length, 1, 'exactly one fallback summary')
    assert.equal(summaries[0].sessionId, 'mem-0001')
    assert.equal(summaries[0].source, 'session-stop')
    assert.equal(summaries[0].local, true, 'locally authored → exportable')
    assert.match(summaries[0].content, /^Task: /)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the fallback summary is idempotent across repeated Stop events', async () => {
  const root = await setupRoot()
  try {
    const transcript = await writeTaskTranscript(root, 'Refactor the login flow to use the shared session guard')
    const input = { session_id: 'mem-0002', transcript_path: transcript, cwd: root }
    runHook(root, input)
    runHook(root, input)

    const summaries = (await readObservations(root)).filter((o) => o.type === 'session_summary')
    assert.equal(summaries.length, 1, 'the second Stop must not add a duplicate')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a noisy task title is not written to memory', async () => {
  const root = await setupRoot()
  try {
    // An auto-commit "log session <hash>" session carries no real task.
    const transcript = await writeTaskTranscript(root, 'log session abc12345 (Dev)')
    runHook(root, { session_id: 'mem-0003', transcript_path: transcript, cwd: root })

    const summaries = (await readObservations(root)).filter((o) => o.type === 'session_summary')
    assert.equal(summaries.length, 0, 'noise must not pollute the store')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a bare ticket key derived as the task is rejected as noise', async () => {
  const root = await setupRoot()
  try {
    // JIRA_PREFIX is set for this file, so the fixture transcript's task derives
    // to "PROJ-123" — no context, and the ticket already rides on the event.
    runHook(root, { session_id: 'mem-0004', transcript_path: FIXTURE_TRANSCRIPT, cwd: root })

    const summaries = (await readObservations(root)).filter((o) => o.type === 'session_summary')
    assert.equal(summaries.length, 0, 'a bare ticket is not a session summary')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
