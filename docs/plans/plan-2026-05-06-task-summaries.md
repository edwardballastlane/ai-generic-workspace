# Implementation Plan — Phase 2: Task Summary Quality

**Spec**: `docs/specs/spec-2026-05-06-task-summaries.md` (in repo, just authored)
**Branch (planned)**: `feat/node-port-phase-2-task-summaries` off `master` (after Phase 1 PR merges)
**Repo**: `<workspace-root>`

---

## Context

Phase 1 of the Node port (`feat/node-port-phase-1-session-stop`) is pushed and awaiting CI + manual Windows verification. Phase 2 builds on that foundation to fix the `task` field quality in `.ai-memory/session-end-events.jsonl`. Today's heuristic picks the longest non-secret user prompt up to 140 chars, producing labels like `"Can we check https://7emhx78432.execute-api... limit=100&offset=0..."`. The spec defines two complementary improvements:

- **Path C (hook-side, free, synchronous)** — multi-signal fallback using git commits in the session window + resume notes from `.ai-session/resume/`, both already available at hook time.
- **Path B (offline, LLM-backed)** — new `--apply-recaps` mode on `scripts/reconcile-session-events.js` that calls `claude --print --resume <sid> "<fixed-recap-prompt>"` (verified working — the slash command `/recap` itself is interactive-only, but a natural-language prompt gives equivalent quality).

All four open questions in the spec are resolved (resume-first signal order, always-write `task_source`, same UUID for `--resume`, full-events backfill).

---

## Tasks (8 total, dependency-graphed)

### Wave 1 — Independent utility ports (3 tasks, fully parallel)

#### T1: `extractCommitsInWindow(rootDir, startedAt, lastActive)` in `_lib/heuristics.js`
- Node port of `best_commits()` from `scripts/session-label:126-143`.
- `execFileSync('git', ['log', '--after=...', '--before=...', '--format=%s', '--no-merges'], {timeout: 3000})`
- Strip conventional-commit prefix (`/^(feat|fix|chore|docs|refactor|test|ci)(\([^)]+\))?:\s*/`); prefer non-`chore:` subjects.
- Return up to 2 subjects joined with ` / `, each truncated to 90 chars. Empty string on any error.
- Tests: `tests/_lib/heuristics.test.js` — add 4 cases (commits-with-non-chore, only-chore-fallback, empty-window, git-error-graceful).

#### T2: `readResumeNote(resumeDir, sessionId)` in `_lib/heuristics.js`
- Node port of `resume_note()` from `scripts/session-label:150-161`.
- `fs.readdirSync(resumeDir)` + filter by prefix `sessionId.slice(0, 8)`, take last by lex sort.
- Read file, extract text under `## Note from previous session` until next `##`.
- Drop blank lines and lines containing `pre-compact (auto)`.
- Return first qualifying line truncated to 140 chars; `''` if none.
- Tests: 4 cases (note-present-good, only-auto-compact-skipped, no-matching-file, empty-section).

#### T3: `isWeakTask(task)` in `_lib/heuristics.js`
- Pure predicate per spec §6.1.
- Returns `false` for: matches `/^$JIRA_PREFIX-[0-9]+/`, OR length 10–100 with no URL/no-leading-question-word.
- Returns `true` for: empty, contains URL, ends with `...`, length > 120.
- Tests: 6 cases — exact strings from spec §1 must return `true`; structured commit subjects must return `false`.

### Wave 2 — Composition layer (2 tasks, parallel)

#### T4: `deriveTaskSummary(opts)` in `_lib/heuristics.js` — depends on T1, T2
- Orchestrates the 5-signal chain per spec §6.1 (post-OQ-1: **resume-first** order matching `session-label --auto`).
- Signal order: 1) ticket+commit, 2) commit only, 3) resume note, 4) ticket only, 5) `extractTask`. Each signal passes its output through `looksLikeSecret`; if matched, falls through to next.
- Returns `{ task, source }`.
- Tests: 6 integration cases covering each signal-source path + secret-fallthrough.

#### T6: `--apply-recaps` mode in `scripts/reconcile-session-events.js` — depends on T3
- New CLI flags: `--apply-recaps`, `--since <ISO>`, `--max-cost <usd>` (extends existing `--session`, `--apply`).
- New `runApplyRecaps(args, ctx)` function (~70 lines) that:
  1. Filters events by `isWeakTask` + `task_source !== 'recap'` + valid UUID + optional `--since`/`--session`
  2. Dry-run print if no `--apply`
  3. For each candidate: cost cap check → `spawnSync('claude', ['--print', '--resume', sid, FIXED_PROMPT], {timeout: 60000, encoding: 'utf8'})` → status/error/secret guards → sanitize → stage update with `task_source='recap'`, `task_recap_hash=sha1(stdout)`.
  4. Reuse existing `applyWrites` for the safe write (backup + race-guard + atomicWrite).
- `FIXED_PROMPT` is the verified prompt from the spec OQ-3.5 resolution.
- Tests: `tests/scripts/reconcile.test.js` — 5 new cases (filter selects only weak, idempotent on `task_source==='recap'`, cost cap aborts cleanly, secret in recap output skips, claude-binary-missing skips gracefully). Use a stub `claude` binary on PATH for tests (small bash script that echoes a fixture or exits non-zero).

### Wave 3 — Integration (1 task, sequential)

#### T5: Wire `deriveTaskSummary` into `scripts/hooks/session-stop.js` — depends on T4
- Replace the `extractTask(t.userPrompts)` call with:
  ```js
  const derived = deriveTaskSummary({
    userPrompts: t.userPrompts,
    sessionId: effectiveSessionId,
    startedAt: sidecar?.started_at || '',
    lastActive: sidecar?.last_active || '',
    rootDir: ROOT
  });
  const taskFb = heuristicsDisabled ? '' : derived.task;
  const taskSourceFb = heuristicsDisabled ? '' : derived.source;
  ```
- Pass `task_source: taskSourceFb` (or sidecar-supplied value) into both branches of `buildEvent` (sidecar + no-sidecar).
- Update `tests/hooks/session-stop.test.js`: extend the 3 existing tests to assert `event.task_source` is one of the expected values; add 1 new test confirming git-commit signal fires when synthetic git history is present in the tempdir.

### Wave 4 — Operations (1 task, sequential)

#### T8: Smoke test + initial backfill — depends on T5, T6
- Run on the live events file (after merging T5+T6):
  1. `node scripts/reconcile-session-events.js --apply-recaps --dry-run` — preview count + sample SIDs
  2. Visually inspect 5 sample candidates' transcripts to confirm /recap-quality output is appropriate
  3. `node scripts/reconcile-session-events.js --apply-recaps --max-cost 30 --apply`
  4. Confirm `--audit` shows the same `match` count post-write (recap doesn't break attribution heuristic)
- Output: a `chore: backfill task summaries via --apply-recaps (N events, $X)` commit on the events file.

---

## Wave Plan & Parallelism

| Wave | Tasks | Concurrency | Cumulative time (1-dev w/ subagents) |
|------|-------|-------------|--------------------------------------|
| 1 | T1, T2, T3 | 3-way parallel | ~2h |
| 2 | T4, T6 | 2-way parallel | ~6h (T6 is the long pole) |
| 3 | T5 | sequential | ~1h |
| 4 | T8 | sequential | ~1h (mostly waiting on LLM calls) |
| **Total** | **8 tasks** | **max 3 parallel** | **~10h elapsed** |

With `/swarm-implement` and an agent team, Waves 1+2 collapse — all 5 independent tasks (T1, T2, T3, T4-stub, T6-stub) can be drafted in parallel by separate implementers, with T4 and T6 finalized after Wave 1 returns.

---

## Suggested team config for `/swarm-implement`

| Teammate | Role | Owns |
|----------|------|------|
| `implementer-utils` | sonnet, TDD focus | T1, T2, T3 |
| `implementer-orchestrator` | sonnet | T4, T5 |
| `implementer-cli` | sonnet | T6 (largest) |
| `reviewer` | haiku per task, sonnet for T6 | spec + quality reviews per the subagent-driven-development pattern |
| `tester-ops` | sonnet | T8 (smoke + dry-run + apply) |

Single developer running `/swarm-implement` orchestrates the team. No external coordination needed — all tasks are within this repo.

---

## Critical files (already exist, read before modifying)

- `scripts/_lib/heuristics.js` (95 lines) — adds 4 new exports (`extractCommitsInWindow`, `readResumeNote`, `isWeakTask`, `deriveTaskSummary`); keeps `extractTask`, `extractJiraTicket`, `looksLikeSecret`, `getGitUser`.
- `scripts/_lib/transcript.js` — read-only, unchanged.
- `scripts/_lib/process.js` — read-only, unchanged.
- `scripts/hooks/session-stop.js` (~230 lines after Phase 1 cleanup) — modify only the heuristic-fallback section in `buildEvent` and `main`.
- `scripts/reconcile-session-events.js` (~390 lines) — extend `parseArgs` and add `runApplyRecaps`. Reuse `applyWrites`, `parseSessionEndRows`.
- `scripts/session-label` (bash, ~300 lines) — READ ONLY, port `best_commits()` and `resume_note()` from it.
- `tests/_lib/heuristics.test.js` — add tests for T1–T4 (~14 new cases).
- `tests/scripts/reconcile.test.js` — add 5 new cases for `--apply-recaps`.
- `tests/hooks/session-stop.test.js` — extend 3 existing + add 1 new for `task_source`.

---

## Verification

- `npm test` — must show 31 (current) + ~14 + 5 + 1 = ~51 passing tests.
- `node scripts/reconcile-session-events.js --apply-recaps --dry-run` — prints candidate count without writing.
- `echo '{...}' | node scripts/hooks/session-stop.js` — smoke test: writes an event with `task_source` field populated.
- Read 5 random rows from `.ai-memory/session-end-events.jsonl` after T8 — visually confirm recap-quality summaries replaced raw prompts.
- Phase 1's cross-OS smoke pipeline (`bitbucket-pipelines.yml` pull-requests block) re-runs against the new branch — must stay green.

---

## Risks & open items (carryover from spec)

- `claude --print --resume` may fail for ~30 % of sessions with pruned transcripts (AC-11) — handled by skip-and-warn; final commit message should report skip count.
- `runApplyRecaps` will write to a git-tracked file; `--apply-recaps` must invoke the existing `applyWrites` race-guard correctly. **Test must spawn a fake concurrent appender** to confirm the guard fires and aborts cleanly.
- Cost ceiling (`--max-cost 30`) is the only safety net against runaway LLM spend if a future spec change loosens `isWeakTask`. Keep the default conservative.

---

## Out-of-scope reminders (from spec §3)

- No live `/recap` in the Stop hook (latency).
- No detached recap from the hook (race + complexity).
- No modification to `scripts/session-label` itself.
- No change to `jira_ticket` derivation.

---

## Output artifacts (saved on plan approval)

This plan file at `~/.claude/plans/federated-percolating-sedgewick.md` (harness location).

The `/breakdown` skill nominally also saves a copy at `docs/plans/plan-2026-05-06-task-summaries.md` for repo-tracked discoverability — recommend doing that on approval. JSON variant via `./scripts/wave-planner --json` is **optional** since this plan has only 8 tasks across 4 waves; the markdown is the source of truth.
