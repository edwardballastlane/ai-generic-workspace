# Specification: Session Task Summary Quality — Phase 2

**Author**: Spec Writer
**Date**: 2026-05-06
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch (planned)**: `feat/node-port-phase-2-task-summaries` (base: `master`)
**Jira**: n/a

---

## 1. Problem Statement

`extractTask` in `scripts/_lib/heuristics.js:52` derives the `task` field for every session event by picking the longest non-secret user prompt, up to 140 chars. Real examples from `.ai-memory/session-end-events.jsonl`:

> `"can we analyzise the different learning systems we have in this wrosknat and compare the better approach. Also make sure we are not burning"`

> `"Can we check https://abc123xyz0.execute-api.us-east-1.amazonaws.com/v1/accounts/36/raw-transactions?limit=100&offset=0&sortBy=date&dir"`

These are stored in a git-tracked, team-shared file (~1900 historical events). The labels feed the token cost dashboard, `scripts/session-label` display, and session semantic search. Bad labels make cost attribution and session discovery useless.

Two complementary fixes address this:

- **Path C (hook-side, free, synchronous)** — replace `extractTask` with a multi-signal fallback chain that reads git commits in the session time window and resume notes from `.ai-session/resume/`. Both signals are deterministic, already exist at hook time, and cost nothing.
- **Path B (reconcile-side, LLM-backed, offline)** — add `--apply-recaps` to `scripts/reconcile-session-events.js`, invoking `claude --print --resume <sid> "/recap"` to produce rich summaries for existing weak events, up to a configurable cost ceiling.

**Impact of not solving**: all ~1900 historical events keep prompt-text labels; every new session appends another weak label; dashboard and session search remain low-signal.

---

## 2. Goals

1. New sessions get task labels derived from git commits and/or `$JIRA_PREFIX-NNN` ticket references rather than prompt text, for any session where those signals are present.
2. Sessions with neither commits nor a Jira reference still get a task label (resume note or existing heuristic) — quality improves incrementally, not all-or-nothing.
3. A single offline command (`--apply-recaps`) backfills existing events with LLM-quality summaries up to a configurable cost ceiling, without corrupting the events file or touching manually-set labels.
4. Every task label written to the events file passes through `looksLikeSecret` — no credentials in the shared JSONL under any code path.
5. The new behavior is cross-platform (Linux, macOS, Windows Node 20+) — no bash-isms in new Node code.

---

## 3. Non-Goals

- Running `/recap` inside the Stop hook. Hook timeout is 5000 ms (`.claude/settings.json:57`); `/recap` latency is 2–8 s.
- Any detached or background recap at session end (race with auto-commit; complexity not justified).
- Modifying `/recap` itself — it is a Claude Code CLI built-in.
- Per-prompt or mid-session summaries. Only the end-of-session `task` field is in scope.
- Porting or modifying `scripts/session-label` — the bash file stays as-is. This spec adds Node equivalents of `auto_label()`, `best_commits()`, and `resume_note()` as library functions only.
- Changing how `jira_ticket` is derived — only `task` is in scope.

---

## 4. User Stories

**US-1 — Better live labels.** When I end a session where I committed `fix: PROJ-1234 lambda cache`, the `task` field reads `"PROJ-1234 lambda cache"` instead of a pasted prompt.

**US-2 — Historical backfill.** Running `node scripts/reconcile-session-events.js --apply-recaps --max-cost 30 --apply` replaces weak labels across historical events with LLM-quality summaries, without touching events whose labels were set via `session-label --set`.

**US-3 — Safe re-run.** Running `--apply-recaps` twice produces no changes on the second run.

---

## 5. Acceptance Criteria

**AC-1** — Given a session with an `$JIRA_PREFIX-NNN` ticket in the first user prompt and non-chore commits in its time window, when the Stop hook fires, then `event.task` is `"<TICKET> <stripped-commit-subject>"` truncated to 140 chars and `event.task_source === 'commit'`.

**AC-2** — Given a session with commits but no `$JIRA_PREFIX-NNN` ticket, when the Stop hook fires, then `event.task` is the first non-chore commit subject stripped of its conventional-commit prefix (up to 2 subjects joined with ` / `) and `event.task_source === 'commit'`.

**AC-3** — Given a session with an `$JIRA_PREFIX-NNN` ticket in the first user prompt but no commits, when the Stop hook fires, then `event.task` is the ticket key alone and `event.task_source === 'ticket'`.

**AC-4** — Given a session with no commits and no `$JIRA_PREFIX-NNN` ticket, but a resume file at `.ai-session/resume/<short-id>*.md` containing a non-empty, non-`pre-compact (auto)` `## Note from previous session` section, when the Stop hook fires, then `event.task` is the first qualifying line of that note and `event.task_source === 'resume'`.

**AC-5** — Given a session where all four signals yield nothing, when the Stop hook fires, then `event.task` is the existing `extractTask(userPrompts)` result and `event.task_source === 'prompt'`.

**AC-6** — Given a sidecar file with a non-empty `.task` field (set via `scripts/session-label --set`), when the Stop hook fires, then `event.task` equals the sidecar value regardless of `deriveTaskSummary` output. (Preserved by existing gate at `session-stop.js:93` — no code change required.)

**AC-7** — Given any derived task string containing a pattern matched by `looksLikeSecret`, when it would be written to the events file, then it is discarded and the signal chain falls through to the next lower signal.

**AC-8** — Given `node scripts/reconcile-session-events.js --apply-recaps` without `--apply`, when run, then it prints how many events would be updated and their session IDs without modifying the file.

**AC-9** — Given `--apply-recaps --max-cost 30 --apply`, when the cumulative estimated cost of `/recap` calls reaches $30, then processing stops and the script exits 0 after logging updates made and cost spent.

**AC-10** — Given an event with `task_source === 'recap'` already set, when `--apply-recaps` processes that event, then it is skipped (no `/recap` call, no write).

**AC-11** — Given a session whose transcript is pruned or unavailable, when `claude --print --resume <sid> "/recap"` exits non-zero or returns empty stdout, then the script logs a warning, skips that session, and continues.

**AC-12** — Given the Stop hook running on any supported OS, when `deriveTaskSummary` invokes `git log`, then it uses `execFileSync` with an argument array (no shell), catches all errors, and completes in under 500 ms.

---

## 6. Technical Design

### 6.1 API Contracts

**`deriveTaskSummary(opts)` — new export from `scripts/_lib/heuristics.js`**

```js
/**
 * @param {object} opts
 * @param {string[]} opts.userPrompts  - from readTranscript (available in hook)
 * @param {string}   opts.sessionId    - UUID
 * @param {string}   opts.startedAt    - ISO-8601 from sidecar.started_at; '' if unavailable
 * @param {string}   opts.lastActive   - ISO-8601 from sidecar.last_active; '' if unavailable
 * @param {string}   opts.rootDir      - absolute path (process.cwd() in hook)
 * @param {string}   [opts.resumeDir]  - defaults to <rootDir>/.ai-session/resume
 * @returns {{ task: string, source: 'commit'|'ticket'|'resume'|'prompt'|'' }}
 */
function deriveTaskSummary(opts)
```

Signal evaluation order:

| Priority | Signal | Condition | `source` |
|----------|--------|-----------|----------|
| 1 | `$JIRA_PREFIX-NNN` from first user prompt + non-chore git log subject in session window | Both present | `'commit'` |
| 2 | Non-chore git log subject in session window (no ticket) | Commits present, no ticket | `'commit'` |
| 3 | `$JIRA_PREFIX-NNN` from first user prompt only | Ticket present, no commits | `'ticket'` |
| 4 | First non-blank, non-auto-compact line from resume note | Resume note present | `'resume'` |
| 5 | `extractTask(userPrompts)` | All else failed | `'prompt'` |

Git log behavior (Node port of `best_commits()` at `scripts/session-label:126-143`):
- `git log --after=<startedAt> --before=<lastActive+10min> --format=%s --no-merges`
- Prefer non-`chore:` subjects; fall back to chore-only if nothing else
- Up to 2 subjects joined with ` / `; each stripped of conventional-commit prefix and truncated to 90 chars
- If `startedAt` or `lastActive` is empty, skip git signals entirely

Resume note behavior (Node port of `resume_note()` at `scripts/session-label:150-161`):
- Find latest `<resumeDir>/<sid[0..8]>*.md` by lexicographic sort (last file wins, matching bash `sort | tail -1`)
- Extract text under `## Note from previous session` up to the next `##` heading
- Discard lines containing `pre-compact (auto)` and blank lines
- Return first qualifying line truncated to 140 chars; `''` if none

**`isWeakTask(task: string): boolean` — new export from `scripts/_lib/heuristics.js`**

```js
/**
 * Returns true when task is empty or looks like raw prompt text rather than a
 * structured label. Used by --apply-recaps to select candidates for /recap.
 * @param {string} task
 * @returns {boolean}
 */
function isWeakTask(task)
```

Returns `false` (strong) for strings that match `/^$JIRA_PREFIX-[0-9]+/` or have the shape of a stripped commit subject (no leading question words, no URL, length 10–100). Returns `true` for empty strings, URL-containing strings, strings ending with `...`, and strings > 120 chars. Exact predicate left to implementer — must return `true` for the two real examples in §1.

**`--apply-recaps` CLI extension on `scripts/reconcile-session-events.js`**

New flags added to `parseArgs`:

```
--apply-recaps            Enable LLM recap mode (mutually exclusive with --fill, --reconcile)
--since <ISO-date>        Restrict to events with ts >= date
--session <sid>           Scope to one session_id (composable with --apply-recaps)
--max-cost <usd>          Abort when cumulative estimated cost exceeds this amount
```

`--apply-recaps` requires `--apply` to write changes (consistent with `--fill --apply` pattern). Without `--apply`, prints dry-run summary only.

Execution flow:

```
1. Parse events file (reuse parseSessionEndRows)
2. Filter: task_source !== 'recap', isWeakTask(ev.task), isValidUuid(ev.session_id)
3. If --since, filter to ev.ts >= since; if --session, filter to that sid
4. If no --apply: print count + sample SIDs and exit
5. For each candidate:
   a. Running cost estimate += $0.01; if > maxCost: log + exit 0
   b. spawnSync('claude', ['--print', '--resume', sid, '/recap'], { timeout: 30_000 })
   c. If status !== 0 or stdout empty: warn, skip
   d. If looksLikeSecret(stdout): warn "recap contains secret-shaped token, skipping", skip
   e. Sanitize: trim, collapse whitespace, truncate to 200 chars
   f. Stage update: task=sanitized, task_source='recap', task_recap_hash=sha1(stdout)
6. applyWrites (reuse existing function: backup + race-guard hash check + atomicWrite)
7. Print: N updated, estimated $X spent, M skipped (error/secret/no-transcript)
```

### 6.2 Data Model

Two optional additive fields on `session_end` rows (backward-compatible; old readers ignore unknown JSON fields):

| Field | Type | Values | Written by |
|-------|------|--------|------------|
| `task_source` | string | `'commit'`, `'ticket'`, `'resume'`, `'prompt'`, `'recap'` | Stop hook (new), `--apply-recaps` |
| `task_recap_hash` | string | SHA-1 hex of raw `/recap` stdout | `--apply-recaps` only |

Idempotency guard for `--apply-recaps`: check `task_source === 'recap'` (do not re-hash). `task_recap_hash` is stored for auditability only.

No migration required. The JSONL is append-only; existing rows remain unchanged until explicitly rewritten by `--apply-recaps --apply`.

### 6.3 Architecture

| File | Change |
|------|--------|
| `scripts/_lib/heuristics.js` | Add `deriveTaskSummary`, `isWeakTask`; keep `extractTask` as Signal 5 fallback. Export both new functions. |
| `scripts/hooks/session-stop.js` | Replace `extractTask(t.userPrompts)` with `deriveTaskSummary({...}).task`. Propagate `.source` as `task_source` on the event object. |
| `scripts/reconcile-session-events.js` | Add `--apply-recaps` branch in `parseArgs`; add `runApplyRecaps` function; import `isWeakTask`. |

No new npm dependencies. Uses `node:child_process.spawnSync`, `node:crypto` (already imported in reconcile), `node:fs` (already imported).

### 6.4 Dependencies

- `claude` CLI on PATH is required only for `--apply-recaps`. Not required at hook time.
- `git` on PATH is required for Signal 1/2. If unavailable or the git call fails, fall through to Signal 3 silently.

---

## 7. Implementation Notes

- `deriveTaskSummary` must be synchronous (hook runs in the main event loop; no `await` budget for git). Use `execFileSync` with `{ encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }`, wrap in `try/catch`.
- When `startedAt`/`lastActive` are absent (no sidecar), skip git signals. Do not fall back to a repository-wide `git log -1` — that would match unrelated commits.
- Resume file lookup uses `sessionId.slice(0, 8)` as the filename prefix, matching the bash `${sid:0:8}` idiom in `session-label:154`. On Windows, `fs.readdirSync` + filter replaces the `ls` glob.
- `spawnSync` in `--apply-recaps` must handle `.error` (spawn failure, e.g. `claude` not on PATH) separately from `.status !== 0` (CLI ran but failed). Both are treated as skip-and-warn.
- The `applyWrites` function at `reconcile-session-events.js` already handles the backup, hash race-guard, and `atomicWrite`. `runApplyRecaps` should call it with its staged corrections map rather than duplicating the write logic.
- `EVENTS_TASK_HEURISTIC_DISABLE=1` (existing env var on the hook) must continue to suppress `deriveTaskSummary` as well (return `{ task: '', source: '' }`).

---

## 8. Cost & Performance Budget

**Path C (hook-side)**

| Step | Target |
|------|--------|
| `git log` via `execFileSync` | < 200 ms |
| Resume note file read | < 50 ms |
| Total `deriveTaskSummary` | < 500 ms (leaving 4500 ms of the 5000 ms Stop hook budget) |
| LLM cost | $0 |

**Path B (one-time backfill)**

| Item | Estimate |
|------|----------|
| Total events in file | ~1900 |
| Events with weak task | ~1400 (verify with `--dry-run`) |
| Sessions without transcript on disk | ~30 % → ~420 skipped |
| Sessions actually recapped | ~980 |
| Cost per session | $0.005–$0.015 (median ~$0.01) |
| Estimated total backfill cost | $10–$15 |
| Recommended `--max-cost` for first run | `30` (2× safety margin) |
| Estimated runtime at 3 s/recap | ~50 min (run offline) |

---

## 9. Risks & Open Questions

### Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `git log` blocks Stop hook on slow machine or huge repo | Low | `execFileSync` with `timeout: 3000`; catch `ETIMEDOUT`; fall through |
| Recap stdout contains a credential pasted in conversation | Low | `looksLikeSecret` guard discards recap, falls back to Path C result |
| `--apply-recaps` corrupts events file if killed mid-write | Very low | `atomicWrite` (tmp+rename) + backup before write; race-guard re-hashes file |
| `claude --print --resume` fails for ~30 % of sessions with pruned transcripts | Medium | Catch non-zero exit; warn + skip; continue (AC-11) |

### Resolved Open Questions

**OQ-1 — Signal order. RESOLVED: resume-note-first.** Match `scripts/session-label --auto` (`auto_label()` at line 164). The bash tool has been running in production; that order reflects maintainer experience. Auto-compact resume notes are already filtered, so the risk of a low-quality resume taking precedence is bounded. Update Signal order table in §6.1 to: 1) `$JIRA_PREFIX-NNN` + commit, 2) commit only, 3) resume note, 4) `$JIRA_PREFIX-NNN` only, 5) extractTask fallback.

**OQ-2 — `task_source` always or sometimes. RESOLVED: always.** Write `task_source` on every new event row. ~20 bytes × 2K rows = ~40 KB total, negligible. Always-present eliminates the ambiguity "missing field = old hook OR new hook with prompt source" and makes downstream filters trivial.

**OQ-3 — `--resume` session ID format. RESOLVED: same UUID.** Verified by running `claude --print --resume <event.session_id>` — accepts the UUID directly. No mapping step needed.

**OQ-3.5 — `/recap` not invokable in --print mode. NEW FINDING.** Testing revealed `claude --print --resume <sid> "/recap"` returns: `"/recap isn't available in this environment."` Slash commands are interactive-only. **Workaround verified:** a fixed natural-language prompt produces equivalent quality. Replace the `/recap` invocation in §6.1 execution flow step 5b with:

```
spawnSync('claude', [
  '--print',
  '--resume', sid,
  'Summarize what was actually accomplished in this session in 1-2 sentences. Focus on concrete outcomes (commits, PRs, decisions). No fluff. Under 200 chars.'
], { timeout: 60_000, encoding: 'utf8' })
```

Real-world test on session `d4d5e4f5-b5b3-4e71-8e75-11e9a6ad1435` returned: *"Diagnosed PROJ-13655 root cause: `TransactionService.updateTransaction` (TransactionService.js:2083-2098) doesn't reconcile `amount/quantity/price` invariant; awaiting Option B confirmation to fix."* — matches the `task` quality target. All other Path B logic (cost cap, secret filter, idempotency, atomic write) remains unchanged.

**OQ-4 — Backfill scope. RESOLVED: all events.** `--apply-recaps` without `--since` processes the full event file. With `--max-cost 30`, hard-capped at ~$30 (estimated actual: $10–$15). Pre-Phase-1 events with empty sidecar fields are still recap-eligible; the LLM call works regardless of sidecar state.

---

## Appendix: Affected File Map

```
scripts/
  _lib/
    heuristics.js               ← ADD deriveTaskSummary, isWeakTask; KEEP extractTask
  hooks/
    session-stop.js             ← CHANGE extractTask → deriveTaskSummary; ADD task_source
  reconcile-session-events.js   ← ADD --apply-recaps mode, runApplyRecaps, isWeakTask import
.claude/
  settings.json                 ← no change (hook timeout already 5000ms)
```

---

*Grounded on: `scripts/_lib/heuristics.js`, `scripts/_lib/transcript.js`, `scripts/_lib/process.js`, `scripts/reconcile-session-events.js`, `scripts/hooks/session-stop.js`, `scripts/session-label`, `.ai-session/resume/*.md` (samples), `.ai-memory/session-end-events.jsonl` (samples), `.claude/settings.json`.*
