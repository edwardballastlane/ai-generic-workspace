'use strict';

// Test fixtures use PROJ-* Jira keys; set the prefix before subprocess spawn.
process.env.JIRA_PREFIX = 'PROJ'; // fixtures hardcode PROJ-; do not defer to the ambient value

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const fsSync = require('node:fs');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'reconcile-session-events.js');
const FIXTURE_EVENTS = path.join(__dirname, '..', 'fixtures', 'events-mixed.jsonl');
const FIXTURE_TRANSCRIPTS = path.join(__dirname, '..', 'fixtures', 'transcripts');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function copyFixture(dir) {
  const eventsPath = path.join(dir, 'events.jsonl');
  await fs.copyFile(FIXTURE_EVENTS, eventsPath);
  return eventsPath;
}

function readLines(filePath) {
  return fsSync.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

// ── Test 1: --audit classifies events correctly ──────────────────────────────

test('--audit classifies all 5 event categories correctly', async () => {
  const r = run([
    '--audit',
    '--events', FIXTURE_EVENTS,
    '--transcript-dir', FIXTURE_TRANSCRIPTS,
  ]);
  assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const out = r.stdout;
  // Total should be 5
  assert.match(out, /Total session_end events.*5/);
  // Each category should appear with count 1
  assert.match(out, /match.*1/);
  assert.match(out, /empty_fillable.*1/);
  assert.match(out, /sidecar_leak.*1/);
  assert.match(out, /mid_session_drift.*1/);
  assert.match(out, /no_transcript.*1/);
});

// ── Test 2: --fill --apply only changes empty_fillable rows ─────────────────

test('--fill --apply only fills empty fields, leaves others unchanged', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
  try {
    const eventsPath = await copyFixture(tmpDir);
    const r = run([
      '--fill', '--apply',
      '--events', eventsPath,
      '--transcript-dir', FIXTURE_TRANSCRIPTS,
    ]);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const rows = readLines(eventsPath);
    assert.equal(rows.length, 5);

    // empty_fillable row (session 0002) should now have task + jira from transcript
    const filled = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000002');
    assert.ok(filled.task.length > 0, 'empty_fillable task should be filled');
    assert.equal(filled.jira_ticket, 'PROJ-1001', 'empty_fillable jira should be filled');

    // sidecar_leak (session 0003): jira_ticket must remain PROJ-9999 (not cleared)
    const leak = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000003');
    assert.equal(leak.jira_ticket, 'PROJ-9999', 'sidecar_leak jira_ticket must be unchanged');

    // mid_session_drift (session 0004): jira_ticket must remain PROJ-3333 (not overwritten)
    const drift = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000004');
    assert.equal(drift.jira_ticket, 'PROJ-3333', 'mid_session_drift jira_ticket must be unchanged');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 3: --reconcile --apply corrects all 3 non-match categories ──────────

test('--reconcile --apply corrects sidecar_leak and mid_session_drift', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
  try {
    const eventsPath = await copyFixture(tmpDir);
    const r = run([
      '--reconcile', '--apply',
      '--events', eventsPath,
      '--transcript-dir', FIXTURE_TRANSCRIPTS,
    ]);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const rows = readLines(eventsPath);
    assert.equal(rows.length, 5);

    // empty_fillable (0002): filled
    const filled = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000002');
    assert.equal(filled.jira_ticket, 'PROJ-1001');

    // sidecar_leak (0003): PROJ-9999 cleared (transcript has no ticket)
    const leak = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000003');
    assert.equal(leak.jira_ticket, '', 'sidecar_leak jira_ticket should be cleared');
    assert.equal(leak.task, 'refactor the database connection pool settings',
      'sidecar_leak task should be replaced from transcript');

    // mid_session_drift (0004): PROJ-3333 replaced with PROJ-2002
    const drift = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000004');
    assert.equal(drift.jira_ticket, 'PROJ-2002', 'mid_session_drift jira_ticket should be corrected');

    // match row (0001): unchanged
    const match = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000001');
    assert.equal(match.task, 'implement login feature with JWT tokens and refresh flow');
    assert.equal(match.jira_ticket, '');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 4: --session scopes writes to one session_id ───────────────────────

test('--session --reconcile --apply only touches the specified session', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
  try {
    const eventsPath = await copyFixture(tmpDir);
    // Only reconcile the mid_session_drift row
    const r = run([
      '--session', 'aaaaaaaa-0000-0000-0000-000000000004',
      '--reconcile', '--apply',
      '--events', eventsPath,
      '--transcript-dir', FIXTURE_TRANSCRIPTS,
    ]);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const rows = readLines(eventsPath);
    assert.equal(rows.length, 5);

    // Session 0004 should be corrected
    const drift = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000004');
    assert.equal(drift.jira_ticket, 'PROJ-2002');

    // Session 0003 (sidecar_leak) must be untouched — not in scope
    const leak = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000003');
    assert.equal(leak.jira_ticket, 'PROJ-9999', 'out-of-scope session must be untouched');

    // Session 0002 (empty_fillable) must be untouched
    const empty = rows.find(r => r.session_id === 'aaaaaaaa-0000-0000-0000-000000000002');
    assert.equal(empty.task, '', 'out-of-scope session task must be untouched');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 5: bare --apply (no --fill or --reconcile) exits non-zero ───────────

test('--apply without --fill or --reconcile exits non-zero with usage hint', () => {
  const r = run(['--apply', '--events', FIXTURE_EVENTS, '--transcript-dir', FIXTURE_TRANSCRIPTS]);
  assert.notEqual(r.status, 0, '--apply alone should exit non-zero');
  const combined = r.stderr + r.stdout;
  assert.match(combined, /--fill/, 'should mention --fill');
  assert.match(combined, /--reconcile/, 'should mention --reconcile');
});

// ── --apply-recaps tests ─────────────────────────────────────────────────────

const isWin = process.platform === 'win32';

/**
 * Run `fn` with a stub `claude` binary on PATH. The stub script body is
 * provided by the caller. Linux/macOS only — tests using this helper skip
 * on Windows because PATH separator and chmod semantics differ.
 */
async function withStubClaude(stubScript, fn) {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-claude-'));
  const stubPath = path.join(stubDir, 'claude');
  await fs.writeFile(stubPath, stubScript, { mode: 0o755 });
  fsSync.chmodSync(stubPath, 0o755);
  const newPath = `${stubDir}:${process.env.PATH}`;
  try {
    return await fn(newPath);
  } finally {
    await fs.rm(stubDir, { recursive: true, force: true });
  }
}

const WEAK_EVENT_BASE = {
  type: 'session_end',
  ts: '2026-01-01T00:00:00Z',
  task: 'Can we fix the thing?',
  jira_ticket: '',
  cost_usd: 0.01,
  input_tokens: 100,
  output_tokens: 100
};

test('--apply-recaps --dry-run prints candidate count without modifying file',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
    try {
      const eventsPath = path.join(tmpDir, 'events.jsonl');
      const weak = { ...WEAK_EVENT_BASE,
        session_id: 'aaaaaaaa-1111-2222-3333-000000000001' };
      const strong = { ...WEAK_EVENT_BASE,
        session_id: 'aaaaaaaa-1111-2222-3333-000000000002',
        task: 'PROJ-1234 fix lambda cache' };
      await fs.writeFile(eventsPath,
        [JSON.stringify(weak), JSON.stringify(strong), ''].join('\n'));
      const r = run(
        ['--apply-recaps', '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS]
      );
      assert.equal(r.status, 0, `exit ${r.status} stderr=${r.stderr}`);
      assert.match(r.stdout, /Would recap 1 events/);
      const after = await fs.readFile(eventsPath, 'utf8');
      assert.match(after, /Can we fix the thing/);
      assert.match(after, /PROJ-1234 fix lambda/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

test('--apply-recaps --apply rewrites weak rows with stub recap output',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    await withStubClaude(
      '#!/bin/sh\nprintf "Implemented widget feature with tests"\n',
      async (PATH) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
        try {
          const eventsPath = path.join(tmpDir, 'events.jsonl');
          const weak = { ...WEAK_EVENT_BASE,
            session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
            task: 'Can we?' };
          await fs.writeFile(eventsPath, JSON.stringify(weak) + '\n');
          const r = run(
            ['--apply-recaps', '--apply',
              '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
            { PATH }
          );
          assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
          const rows = readLines(eventsPath);
          assert.equal(rows[0].task, 'Implemented widget feature with tests');
          assert.equal(rows[0].task_source, 'recap');
          assert.match(rows[0].task_recap_hash, /^[0-9a-f]{40}$/);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }
    );
  });

test('--apply-recaps idempotent: skips rows where task_source==="recap"',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    await withStubClaude(
      '#!/bin/sh\nprintf "DIFFERENT OUTPUT FROM SECOND CALL"\n',
      async (PATH) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
        try {
          const eventsPath = path.join(tmpDir, 'events.jsonl');
          const alreadyRecapped = { ...WEAK_EVENT_BASE,
            session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
            task: 'Can we?',
            task_source: 'recap',
            task_recap_hash: 'abc123' };
          await fs.writeFile(eventsPath, JSON.stringify(alreadyRecapped) + '\n');
          const r = run(
            ['--apply-recaps', '--apply',
              '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
            { PATH }
          );
          assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
          const rows = readLines(eventsPath);
          assert.equal(rows[0].task, 'Can we?');
          assert.notEqual(rows[0].task, 'DIFFERENT OUTPUT FROM SECOND CALL');
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }
    );
  });

test('--apply-recaps respects --max-cost ceiling',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    await withStubClaude(
      '#!/bin/sh\nprintf "summary"\n',
      async (PATH) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
        try {
          const eventsPath = path.join(tmpDir, 'events.jsonl');
          const events = [];
          for (let i = 1; i <= 5; i++) {
            events.push(JSON.stringify({ ...WEAK_EVENT_BASE,
              session_id: `aaaaaaaa-1111-2222-3333-00000000000${i}`,
              task: `Can we ${i}?` }));
          }
          await fs.writeFile(eventsPath, events.join('\n') + '\n');
          const r = run(
            ['--apply-recaps', '--apply', '--max-cost', '0.025',
              '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
            { PATH }
          );
          assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
          assert.match(r.stdout, /Cost ceiling reached/);
          const rows = readLines(eventsPath);
          const recapped = rows.filter(rw => rw.task_source === 'recap').length;
          assert.ok(recapped >= 1 && recapped <= 3,
            `expected 1-3 recapped (cost ceiling), got ${recapped}`);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }
    );
  });

test('--apply-recaps skips rows whose recap output contains a secret',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    // Build the secret at runtime so the source file does not contain a literal
    // (matches the heuristics.js convention).
    const secret = 'A' + 'KIA' + 'X'.repeat(16);
    await withStubClaude(
      `#!/bin/sh\nprintf "leaked: ${secret}\\n"\n`,
      async (PATH) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
        try {
          const eventsPath = path.join(tmpDir, 'events.jsonl');
          const weak = { ...WEAK_EVENT_BASE,
            session_id: 'aaaaaaaa-1111-2222-3333-000000000001' };
          await fs.writeFile(eventsPath, JSON.stringify(weak) + '\n');
          const r = run(
            ['--apply-recaps', '--apply',
              '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
            { PATH }
          );
          assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
          const rows = readLines(eventsPath);
          assert.equal(rows[0].task, WEAK_EVENT_BASE.task);
          assert.notEqual(rows[0].task_source, 'recap');
          assert.match(r.stderr, /secret/);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }
    );
  });

test('--apply-recaps --apply skips gracefully when claude binary missing',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-claude-'));
    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
      try {
        const eventsPath = path.join(tmpDir, 'events.jsonl');
        const weak = { ...WEAK_EVENT_BASE,
          session_id: 'aaaaaaaa-1111-2222-3333-000000000001' };
        await fs.writeFile(eventsPath, JSON.stringify(weak) + '\n');
        const r = run(
          ['--apply-recaps', '--apply',
            '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
          { PATH: stubDir }
        );
        assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
        const rows = readLines(eventsPath);
        assert.equal(rows[0].task, WEAK_EVENT_BASE.task);
        assert.notEqual(rows[0].task_source, 'recap');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(stubDir, { recursive: true, force: true });
    }
  });

test('--apply-recaps --concurrency 4 recaps all events and overlaps invocations',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    // Stub claude that records the live concurrent count to a log file.
    // Each invocation: increment a counter, sleep, decrement. The max counter
    // value reached during the run proves invocations overlapped.
    const meterDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-meter-'));
    const counterFile = path.join(meterDir, 'counter');
    const peakFile = path.join(meterDir, 'peak');
    fsSync.writeFileSync(counterFile, '0');
    fsSync.writeFileSync(peakFile, '0');
    const stub = `#!/bin/sh
LOCK="${meterDir}/lock"
mkdir -p "$LOCK" 2>/dev/null
# Acquire serialized increment via mkdir-as-lock, with retry.
while ! mkdir "$LOCK/x" 2>/dev/null; do :; done
CUR=$(cat "${counterFile}")
NEW=$((CUR + 1))
echo "$NEW" > "${counterFile}"
PEAK=$(cat "${peakFile}")
if [ "$NEW" -gt "$PEAK" ]; then echo "$NEW" > "${peakFile}"; fi
rmdir "$LOCK/x"

sleep 0.3

while ! mkdir "$LOCK/x" 2>/dev/null; do :; done
CUR=$(cat "${counterFile}")
NEW=$((CUR - 1))
echo "$NEW" > "${counterFile}"
rmdir "$LOCK/x"

printf "stub recap output"
`;
    try {
      await withStubClaude(stub, async (PATH) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
        try {
          const eventsPath = path.join(tmpDir, 'events.jsonl');
          const events = [];
          for (let i = 1; i <= 4; i++) {
            events.push(JSON.stringify({ ...WEAK_EVENT_BASE,
              session_id: `aaaaaaaa-1111-2222-3333-00000000000${i}`,
              task: `Can we ${i}?` }));
          }
          await fs.writeFile(eventsPath, events.join('\n') + '\n');
          const r = run(
            ['--apply-recaps', '--apply', '--concurrency', '4',
              '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
            { PATH }
          );
          assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

          const rows = readLines(eventsPath);
          const recapped = rows.filter(rw => rw.task_source === 'recap').length;
          assert.equal(recapped, 4, `expected all 4 recapped, got ${recapped}`);
          for (const row of rows) {
            assert.equal(row.task, 'stub recap output');
          }

          const peak = Number(fsSync.readFileSync(peakFile, 'utf8').trim());
          assert.ok(peak >= 2,
            `expected peak concurrent invocations >= 2, got ${peak} ` +
            `(implies serial execution; --concurrency flag not honored)`);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      });
    } finally {
      await fs.rm(meterDir, { recursive: true, force: true });
    }
  });

test('--apply-recaps memoizes per session_id: N rows of one sid → 1 invocation',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    const meterDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-memo-'));
    const callCountFile = path.join(meterDir, 'count');
    fsSync.writeFileSync(callCountFile, '0');
    const stub = `#!/bin/sh
LOCK="${meterDir}/lock"
mkdir -p "$LOCK" 2>/dev/null
while ! mkdir "$LOCK/x" 2>/dev/null; do :; done
CUR=$(cat "${callCountFile}")
echo $((CUR + 1)) > "${callCountFile}"
rmdir "$LOCK/x"
printf "memoized recap output"
`;
    try {
      await withStubClaude(stub, async (PATH) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-test-'));
        try {
          const eventsPath = path.join(tmpDir, 'events.jsonl');
          // 5 rows, all same session_id, all weak.
          const sid = 'aaaaaaaa-1111-2222-3333-000000000099';
          const rows = [];
          for (let i = 0; i < 5; i++) {
            rows.push(JSON.stringify({
              ...WEAK_EVENT_BASE,
              session_id: sid,
              ts: `2026-01-01T0${i}:00:00Z`
            }));
          }
          await fs.writeFile(eventsPath, rows.join('\n') + '\n');
          const r = run(
            ['--apply-recaps', '--apply',
              '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
            { PATH }
          );
          assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

          const callCount = Number(fsSync.readFileSync(callCountFile, 'utf8').trim());
          assert.equal(callCount, 1,
            `expected 1 claude invocation for 5 rows of one session_id, got ${callCount}`);

          const after = readLines(eventsPath);
          assert.equal(after.length, 5);
          for (const row of after) {
            assert.equal(row.task, 'memoized recap output');
            assert.equal(row.task_source, 'recap');
          }
          // All rows should share the same hash (same recap output).
          const hashes = new Set(after.map(r => r.task_recap_hash));
          assert.equal(hashes.size, 1, 'all rows from one sid should share one hash');
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      });
    } finally {
      await fs.rm(meterDir, { recursive: true, force: true });
    }
  });

test('--concurrency rejects values < 1 and non-numeric',
  async () => {
    for (const bad of ['0', '-1', 'abc']) {
      const r = run(['--apply-recaps', '--concurrency', bad]);
      assert.notEqual(r.status, 0, `--concurrency ${bad} should fail`);
      assert.match(r.stderr, /--concurrency/);
    }
  });

test('--apply-recaps tolerates appended rows during the run, preserves them',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    // Stub claude itself appends a new event row to the events file during
    // its (slow) invocation, simulating a session-stop hook firing mid-recap.
    // The race-guard must detect this is an append-only change, preserve the
    // new row in the rewritten file, and apply our correction.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-append-'));
    try {
      const eventsPath = path.join(tmpDir, 'events.jsonl');
      const newRow = JSON.stringify({
        type: 'session_end',
        session_id: 'bbbbbbbb-2222-3333-4444-000000000002',
        ts: '2026-05-07T12:00:00Z',
        task: 'newer event'
      });
      const stub = `#!/bin/sh
printf '%s\\n' '${newRow}' >> '${eventsPath}'
printf "Stub recap text"
`;
      await withStubClaude(stub, async (PATH) => {
        const weak = { ...WEAK_EVENT_BASE,
          session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
          task: 'Can we?' };
        await fs.writeFile(eventsPath, JSON.stringify(weak) + '\n');
        const r = run(
          ['--apply-recaps', '--apply',
            '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
          { PATH }
        );
        assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

        const rows = readLines(eventsPath);
        assert.equal(rows.length, 2, 'appended row should survive the rewrite');
        assert.equal(rows[0].task, 'Stub recap text');
        assert.equal(rows[0].task_source, 'recap');
        assert.equal(rows[1].session_id, 'bbbbbbbb-2222-3333-4444-000000000002');
        assert.equal(rows[1].task, 'newer event');
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

test('--apply-recaps aborts when the events file prefix is modified mid-run',
  { skip: isWin && 'PATH/chmod stub trick is POSIX-only' },
  async () => {
    // Stub overwrites the file mid-recap (truncate + rewrite — not append).
    // Must trip the prefix-startsWith guard and abort with exit 2.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-modify-'));
    try {
      const eventsPath = path.join(tmpDir, 'events.jsonl');
      const stub = `#!/bin/sh
printf '%s\\n' '{"type":"other"}' > '${eventsPath}'
printf "Stub recap text"
`;
      await withStubClaude(stub, async (PATH) => {
        const weak = { ...WEAK_EVENT_BASE,
          session_id: 'aaaaaaaa-1111-2222-3333-000000000001',
          task: 'Can we?' };
        await fs.writeFile(eventsPath, JSON.stringify(weak) + '\n');
        const r = run(
          ['--apply-recaps', '--apply',
            '--events', eventsPath, '--transcript-dir', FIXTURE_TRANSCRIPTS],
          { PATH }
        );
        assert.equal(r.status, 2, `expected exit=2, got ${r.status} stderr=${r.stderr}`);
        assert.match(r.stderr, /modified \(not appended\)/);
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
