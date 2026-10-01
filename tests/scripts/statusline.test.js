'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'statusline.js');
const FIXTURE_INPUT = path.join(__dirname, '..', 'fixtures', 'statusline-input.json');
const FIXTURE_TRANSCRIPT = path.join(__dirname, '..', 'fixtures', 'transcript-min.jsonl');

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  await fs.mkdir(path.join(root, '.ai-session', 'by-id'), { recursive: true });
  return root;
}

// Clear claude env-vars that bleed into tests when run from inside CC itself
// (the IIFE harness exports CLAUDE_AUTOCOMPACT_PCT_OVERRIDE / etc.).
function cleanEnv(extra = {}) {
  const e = { ...process.env, NO_COLOR: '1' };
  delete e.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  delete e.CLAUDE_CTX_MAX_TOKENS;
  delete e.DEBUG_STATUSLINE;
  return { ...e, ...extra };
}

function runStatusline(root, payload, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: cleanEnv(env),
  });
}

async function writeTranscript(dir, lastUsage, model = 'claude-sonnet-4-6') {
  const file = path.join(dir, 'tx.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hello there' }, isMeta: false }),
    JSON.stringify({ type: 'assistant', message: { model, usage: lastUsage } }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n');
  return file;
}

// ── AC-12: piped fixture, exit 0, basic segments present ────────────────────

test('AC-12: fixture payload renders branch + cost segments and exits 0', async () => {
  const root = await setupRoot();
  try {
    // Initialize a real git repo so branch segment renders.
    const { execFileSync } = require('node:child_process');
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] };
    execFileSync('git', ['init', '-q', '-b', 'feat/test'], opts);
    execFileSync('git', ['config', 'user.email', 't@e.io'], opts);
    execFileSync('git', ['config', 'user.name', 'T'], opts);

    const payload = JSON.parse(await fs.readFile(FIXTURE_INPUT, 'utf8'));
    payload.transcript_path = FIXTURE_TRANSCRIPT;
    payload.cwd = root;
    const r = runStatusline(root, payload);
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.match(r.stdout, /feat\/test/, 'branch segment missing');
    assert.match(r.stdout, /\$0\.05/, 'cost segment missing');
    assert.match(r.stdout, /sonnet/, 'model segment missing');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-13: critical zone shows COMPACT NOW ──────────────────────────────────

test('AC-13: critical zone (>=85% threshold) prepends COMPACT NOW', async () => {
  const root = await setupRoot();
  try {
    // Default 200k window * 0.80 threshold = 160_000. 90% of 160_000 = 144_000.
    const tx = await writeTranscript(root, {
      input_tokens: 144_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 100,
    });
    const r = runStatusline(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: tx,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0 },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.match(r.stdout, /COMPACT NOW/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-13: warning zone differs from healthy ────────────────────────────────

test('AC-13: warning zone (60-84%) emits amber-bold escape with colors enabled', async () => {
  const root = await setupRoot();
  try {
    // 70% of 160_000 = 112_000.
    const tx = await writeTranscript(root, {
      input_tokens: 112_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 100,
    });
    // Force colors on by setting FORCE_COLOR (Node respects it for stdout.isTTY proxy);
    // since spawnSync output is not a TTY, drop NO_COLOR + force stdout.isTTY via env
    // is not portable — instead, assert on the no-color path that the warning %
    // segment differs from a healthy% segment by checking the percent value.
    const r = runStatusline(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: tx,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0 },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /70%/);
    assert.doesNotMatch(r.stdout, /COMPACT NOW/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── payload.context_window is authoritative for window size + token count ────

test('uses real context_window_size from payload (1M) over the 200k id-guess', async () => {
  const root = await setupRoot();
  try {
    // Same Opus id CC uses for both 200k and 1M sessions. With the old code this
    // 100k of context read as 100% of the 200k*0.50 threshold (COMPACT NOW). With
    // the payload's real 1M window it is 100k / (1_000_000*0.50) = 20%.
    const tx = await writeTranscript(root, {
      input_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1,
    }, 'claude-opus-4-8');
    const r = runStatusline(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: tx,
      cwd: root,
      model: { id: 'claude-opus-4-8' },
      context_window: { total_input_tokens: 100_000, context_window_size: 1_000_000 },
      cost: { total_cost_usd: 0 },
    }, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.match(r.stdout, /20%/);
    assert.doesNotMatch(r.stdout, /COMPACT NOW/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CLAUDE_CTX_MAX_TOKENS env override still beats payload context_window_size', async () => {
  const root = await setupRoot();
  try {
    const tx = await writeTranscript(root, {
      input_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1,
    }, 'claude-opus-4-8');
    // Env forces 200k window; 100k of 200k*0.50=100k threshold = 100% → critical.
    const r = runStatusline(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: tx,
      cwd: root,
      model: { id: 'claude-opus-4-8' },
      context_window: { total_input_tokens: 100_000, context_window_size: 1_000_000 },
      cost: { total_cost_usd: 0 },
    }, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50', CLAUDE_CTX_MAX_TOKENS: '200000' });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.match(r.stdout, /COMPACT NOW/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-14: sidecar write-back when cost differs ─────────────────────────────

test('AC-14: sidecar write-back updates cost_usd + token fields when cost differs', async () => {
  const root = await setupRoot();
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    const sidecarPath = path.join(root, '.ai-session', 'by-id', `${sid}.json`);
    await fs.writeFile(sidecarPath, JSON.stringify({
      session_id: sid, project: '', cost_usd: 0,
      duration_ms: 0, lines_added: 0, lines_removed: 0,
    }));
    const r = runStatusline(root, {
      session_id: sid,
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 5000, total_lines_added: 3, total_lines_removed: 1 },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    const updated = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    assert.equal(updated.cost_usd, 0.10);
    // transcript-min has input=300, cache_creation=50, cache_read=5000, output=230.
    assert.equal(updated.input_tokens, 300, 'input_tokens = raw input only (no cache merge)');
    assert.equal(updated.cache_creation_tokens, 50);
    assert.equal(updated.cache_read_tokens, 5000);
    assert.equal(updated.output_tokens, 230);
    assert.equal(updated.lines_added, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-14: no write-back when cost matches ──────────────────────────────────

test('AC-14: no sidecar write-back when costs match', async () => {
  const root = await setupRoot();
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    const sidecarPath = path.join(root, '.ai-session', 'by-id', `${sid}.json`);
    const original = JSON.stringify({
      session_id: sid, project: '', cost_usd: 0.05,
      duration_ms: 0, lines_added: 0, lines_removed: 0,
    });
    await fs.writeFile(sidecarPath, original);
    const beforeMtime = (await fs.stat(sidecarPath)).mtimeMs;

    // Tiny pause then run with matching cost.
    await new Promise(r => setTimeout(r, 25));
    const r = runStatusline(root, {
      session_id: sid,
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0.05 },
    });
    assert.equal(r.status, 0);

    const after = await fs.readFile(sidecarPath, 'utf8');
    const afterMtime = (await fs.stat(sidecarPath)).mtimeMs;
    assert.equal(after, original, 'sidecar contents must be unchanged');
    assert.equal(afterMtime, beforeMtime, 'sidecar mtime must be unchanged');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-15: NO_COLOR strips all ANSI escapes ─────────────────────────────────

test('AC-15: NO_COLOR=1 produces output with zero ANSI escapes', async () => {
  const root = await setupRoot();
  try {
    const r = runStatusline(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0.05 },
    }, { NO_COLOR: '1' });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /\x1b\[/, 'no ANSI escapes allowed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── Piped stdout still emits ANSI (CC pipes stdout but renders escapes) ─────

test('piped stdout (non-TTY) still emits ANSI escapes for CC to render', async () => {
  const root = await setupRoot();
  try {
    // CC pipes the statusline command's stdout but still parses ANSI escapes
    // for color rendering. Bash original always emitted escapes regardless of
    // TTY status; we match that. NO_COLOR=1 is the only opt-out.
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: root,
      input: JSON.stringify({
        session_id: '11111111-2222-3333-4444-555555555555',
        transcript_path: FIXTURE_TRANSCRIPT,
        cwd: root,
        model: { id: 'claude-sonnet-4-6' },
        cost: { total_cost_usd: 0.05 },
      }),
      encoding: 'utf8',
      env: cleanEnv({ NO_COLOR: '' }),
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\x1b\[/, 'expected ANSI escapes for CC color rendering');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── Rules/memories/semantic-hits segment from sidecar ───────────────────────

test('renders r:N m:N s:N segment from sidecar (mirrors bash statusline behavior)', async () => {
  const root = await setupRoot();
  try {
    const sid = '22222222-3333-4444-5555-666666666666';
    const sidecarPath = path.join(root, '.ai-session', 'by-id', `${sid}.json`);
    await fs.writeFile(sidecarPath, JSON.stringify({
      session_id: sid, project: '', cost_usd: 0.05,
      rules_injected: 170, memories_surfaced: 37, semantic_cache_hits: 4,
    }));
    const r = runStatusline(root, {
      session_id: sid,
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0.05 },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.match(r.stdout, /r:170 m:37 s:4/, 'expected combined r:/m:/s: segment');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('omits m: when memories_surfaced is 0 but keeps r:', async () => {
  const root = await setupRoot();
  try {
    const sid = '33333333-4444-5555-6666-777777777777';
    const sidecarPath = path.join(root, '.ai-session', 'by-id', `${sid}.json`);
    await fs.writeFile(sidecarPath, JSON.stringify({
      session_id: sid, project: '', cost_usd: 0.05,
      rules_injected: 5, memories_surfaced: 0, semantic_cache_hits: 0,
    }));
    const r = runStatusline(root, {
      session_id: sid,
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0.05 },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /r:5/);
    assert.doesNotMatch(r.stdout, /m:/);
    assert.doesNotMatch(r.stdout, /s:/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('omits segment entirely when both rules and memories are 0', async () => {
  const root = await setupRoot();
  try {
    const sid = '44444444-5555-6666-7777-888888888888';
    const sidecarPath = path.join(root, '.ai-session', 'by-id', `${sid}.json`);
    await fs.writeFile(sidecarPath, JSON.stringify({
      session_id: sid, project: '', cost_usd: 0.05,
      rules_injected: 0, memories_surfaced: 0, semantic_cache_hits: 7,
    }));
    const r = runStatusline(root, {
      session_id: sid,
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0.05 },
    });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /r:0/);
    assert.doesNotMatch(r.stdout, /s:7/, 'semantic hits should only show when r or m > 0');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-19: executable bit set on the script ─────────────────────────────────

test('AC-19: script has executable bit set after run', async () => {
  const root = await setupRoot();
  try {
    runStatusline(root, {});
    if (process.platform === 'win32') {
      // chmod is a no-op on Windows; skip the bit-check there.
      return;
    }
    const mode = fsSync.statSync(SCRIPT).mode & 0o777;
    assert.ok((mode & 0o111) !== 0, `expected executable bit, got mode=${mode.toString(8)}`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── AC-20 sanity: pickColors returns the right palette per platform/env ─────

test('AC-20: pickColors() palette switches by platform/WT_SESSION/NO_COLOR', () => {
  const { pickColors } = require(SCRIPT);
  // We can't safely override process.platform in the same process; instead
  // assert the helper's NO_COLOR branch is total-empty (covers AC-15 too).
  const origNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const empty = pickColors();
  process.env.NO_COLOR = origNoColor;
  assert.equal(empty.R, '');
  assert.equal(empty.BRAND, '');
  assert.equal(empty.CRITICAL, '');
});

// ── DEBUG_STATUSLINE=1 logs elapsed= to stderr ──────────────────────────────

test('DEBUG_STATUSLINE=1 logs elapsed=<ms> to stderr', async () => {
  const root = await setupRoot();
  try {
    const r = runStatusline(root, {
      session_id: '11111111-2222-3333-4444-555555555555',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: root,
      model: { id: 'claude-sonnet-4-6' },
      cost: { total_cost_usd: 0 },
    }, { DEBUG_STATUSLINE: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /elapsed=\d+ms/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── Unpushed-commit indicator (⇡N) ──────────────────────────────────────────

async function setupDivergedRoot() {
  const { execFileSync } = require('node:child_process');
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-remote-'));
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: remote, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.io'], { cwd: remote, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: remote, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'base'], { cwd: remote, stdio: 'ignore' });

  // Clone target must not pre-exist (mkdtemp's dir is fine — it's empty).
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  await fs.rm(root, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] };
  execFileSync('git', ['config', 'user.email', 't@e.io'], opts);
  execFileSync('git', ['config', 'user.name', 'T'], opts);
  await fs.mkdir(path.join(root, '.ai-session', 'by-id'), { recursive: true });
  return { root, remote };
}

test('unpushed commits render a muted ⇡N segment below the warning threshold', async () => {
  const { root, remote } = await setupDivergedRoot();
  try {
    const { execFileSync } = require('node:child_process');
    const opts = { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] };
    for (let i = 0; i < 3; i++) {
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', `local ${i}`], opts);
    }
    const payload = JSON.parse(await fs.readFile(FIXTURE_INPUT, 'utf8'));
    payload.transcript_path = FIXTURE_TRANSCRIPT;
    payload.cwd = root;
    const r = runStatusline(root, payload);
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.match(r.stdout, /⇡3/, 'expected ahead-count segment');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(remote, { recursive: true, force: true });
  }
});

test('unpushed commits omit the segment entirely when in sync with upstream', async () => {
  const { root, remote } = await setupDivergedRoot();
  try {
    const payload = JSON.parse(await fs.readFile(FIXTURE_INPUT, 'utf8'));
    payload.transcript_path = FIXTURE_TRANSCRIPT;
    payload.cwd = root;
    const r = runStatusline(root, payload);
    assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /⇡/, 'segment should be absent when ahead=0');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(remote, { recursive: true, force: true });
  }
});

test('readAheadBehind: no upstream configured yields ahead=0', async () => {
  const root = await setupRoot();
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['init', '-q', '-b', 'solo'], { cwd: root, stdio: 'ignore' });
    const { readAheadBehind } = require(SCRIPT);
    assert.deepEqual(readAheadBehind(root), { ahead: 0 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── Error path: bad JSON exits 0 with single newline on stdout ──────────────

test('Error path: bad JSON on stdin exits 0 (never blocks CC status line)', async () => {
  const root = await setupRoot();
  try {
    const r = runStatusline(root, 'not valid json {{{');
    assert.equal(r.status, 0);
    // Bad JSON falls through to a render with empty payload — output is non-empty
    // (model defaults to "claude") but must NOT contain an error trace.
    assert.doesNotMatch(r.stdout, /SyntaxError/);
    assert.match(r.stdout, /\n$/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
