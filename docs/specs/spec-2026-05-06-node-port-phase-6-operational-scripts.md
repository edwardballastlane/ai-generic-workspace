# Specification: Node Port — Phase 6: Operational One-Shot Scripts

**Author**: Spec Writer
**Date**: 2026-05-06
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch (planned)**: `feat/node-port-phase-6-operational-scripts`
**Jira**: n/a

## 1. Problem Statement

Five operational one-shot scripts remain as bash, deferred from Phase 5: `audit-session-attribution.sh` (159 lines), `backfill-jira-from-commits.sh` (331 lines), `reconcile-session-attribution.sh` (339 lines), `backfill-task-from-transcripts.sh` (205 lines), `setup-merge-drivers.sh` (18 lines). All depend on `jq`, `bash`, GNU `date -d`, `find`, `grep -oE`, `awk`, `mktemp`. Windows users encounter immediate failures; macOS users without GNU coreutils have a latent silent-data-loss bug in the date-window backfill.

**Who is affected**: All Lane workspace engineers, especially on Windows and macOS without GNU coreutils.

**Impact of not solving**: One-time data-quality tools (backfill, reconcile, audit) cannot be run cross-platform; new team members on Windows must use WSL just for setup; `CLAUDE.md` carries an incorrect statement about bash permanence.

## 2. Goals

1. Port all five scripts to Node.js 20+, eliminating jq, bash, GNU date, find, grep, awk, mktemp from execution paths.
2. Each ported script invocable on Linux, macOS, and Windows via `node scripts/<name>.js` or the bash/cmd stub siblings.
3. Behavioral parity 1:1: every mode (`--audit`, `--apply`, `--json`), every env-override, every exit code reproduced.
4. Each port has `tests/scripts/<name>.test.js` with at minimum 3 test cases.
5. Bash stubs (2-line `exec node` delegators) and Windows `.cmd` siblings exist for all 5.
6. `npm test` exits 0 on all three CI legs (ubuntu, macos, windows).
7. `CLAUDE.md` updated to remove the "intentionally remain bash" qualifier.

## 3. Non-Goals

- Porting `token-dashboard.sh` (969 lines). The TS dashboard at `scripts/session-embedder/dashboard-generator.ts` is the canonical replacement.
- Changing the CC hook protocol or `session-end-events.jsonl` schema.
- Modifying `agent/_phases/`, `agent/_core/`, `.claude/agents/`.
- Adding new behaviors or new modes beyond what each bash original documents.
- Fixing known bugs in the original bash scripts (preserve semantics 1:1; one explicit exception: GNU `date -d` macOS incompatibility, fixed as a side effect of using JS `Date`).
- Extending the Jira ticket pattern beyond `[A-Z]+-[0-9]+`. The bash scripts use this broad pattern; the Node ports replicate it exactly. `extractJiraTicket` in `heuristics.js` is scoped to `$JIRA_PREFIX` only and must NOT be widened — use a local `BROAD_JIRA_RE = /\b[A-Z]+-[0-9]+\b/g` in the scripts that need the broader pattern.
- Changing the CI `cross-os-smoke.yml` path triggers. Phase 5 already broadened to `paths: ['scripts/**', 'tests/**']`.
- Hot-path performance improvements. These scripts run once per engineer per incident.

## 4. Acceptance Criteria

### setup-merge-drivers.js

**AC-1** — Given run in a git repo, when executed, then `git config merge.jsonl-union.name` is set to `"JSONL union merge (session events)"` and `git config merge.jsonl-union.driver` is set to `"node ./scripts/git-merge-jsonl-union.js %O %A %B"`, exits 0 with confirmation to stdout.

**AC-2** — Given run outside a git repo, when executed, then prints error to stderr and exits non-zero.

**AC-3** — Idempotent: running twice in the same repo leaves git config values unchanged, exits 0 both times.

**AC-4** — `scripts/setup-merge-drivers.sh` becomes 2-line bash stub; `scripts/setup-merge-drivers.cmd` is created.

### audit-session-attribution.js

**AC-5** — Given an events file with at least one event missing `session_id`, when run (default human-readable mode), then stdout contains an `empty_session_id` count matching actual count, exits 0.

**AC-6** — Given the same `session_id` appears with two different `jira_ticket` values, when run, then `--json` output `split_attribution.count` equals 1 and the session's `tickets` array contains both values; human-readable mode prints the session ID and both tickets; exits 0.

**AC-7** — Given a sidecar at `.ai-session/by-id/<sid>.json` whose `project` disagrees with the last event's `project` for that session, when run, then `sidecar_drift.count` is 1 with `ev_project`, `sc_project`, `ev_jira`, `sc_jira` fields; exits 0.

**AC-8** — Given the events file does not exist, when run, then prints `"audit: no events file at <path> — nothing to audit"` to stderr and exits 0.

**AC-9** — Given all three checks return zero issues, when human-readable output is read, then it contains a "no attribution drift detected" line.

**AC-10** — `scripts/audit-session-attribution.sh` becomes 2-line bash stub; `.cmd` sibling created.

### backfill-task-from-transcripts.js

**AC-11** — Given an event where `task` and `jira_ticket` are empty, and a matching transcript file exists with a user prompt containing `PROJ-9876`, when `--audit` runs, then stdout shows `extractable (task and/or jira): 1` and the candidate shows `jira=PROJ-9876`; events file unchanged.

**AC-12** — Given the same setup, when `--apply` runs, then a `.bak.<timestamp>` backup is created, the events file is rewritten with `jira_ticket: "PROJ-9876"`, line count is preserved, exits 0.

**AC-13** — Given a prompt containing a secret-shaped token (matching `looksLikeSecret`), when `--apply` runs, then the `task` field is NOT written (secret dropped), exits 0.

**AC-14** — Given an event where both `task` and `jira_ticket` are already populated, when `--apply` runs, then those fields are NOT overwritten.

**AC-15** — `scripts/backfill-task-from-transcripts.sh` becomes 2-line bash stub; `.cmd` sibling created.

### backfill-jira-from-commits.js

**AC-16** — Given a `session_end` event with `session_id`, `user`, `ts` but no `jira_ticket`, and at least one git commit within `±WINDOW_HOURS` of `ts` by that user's email containing ticket `PROJECT-1234`, when `--audit` runs, then stdout shows `back-fill candidate: 1` and `PROJECT-1234` appears in the candidate output; events file unchanged.

**AC-17** — Given `--apply` mode with one qualifying event, when run, then `.bak` is created, the event gains `attribution_review_needed: true`, `attribution_method: "commit_window"`, `primary_jira_ticket: "PROJECT-1234"`; original `jira_ticket` preserved.

**AC-18** — Given two distinct tickets with equal commit counts (tied plurality), when run, then the event is `AMBIGUOUS` (skipped), `multi-ticket window` count increments, no annotation written.

**AC-19** — Given `WINDOW_HOURS=0` env override, when run, then all events show `no-ticket window` and `back-fill candidate` is 0.

**AC-20** — `scripts/backfill-jira-from-commits.sh` becomes 2-line bash stub; `.cmd` sibling created.

### reconcile-session-attribution.js

**AC-21** — Given a split-session (same `session_id`, two different `jira_ticket` values) and a CC transcript at `~/.claude/projects/<slug>/<sid>.jsonl` mentioning only one of the tickets in user prompts, when `--audit` runs, then the session is classified with `method=transcript` and the primary ticket is the transcript-mentioned one.

**AC-22** — Given the same setup, when `--apply` runs, then `.bak` is created; the minority-ticket event gains `attribution_review_needed: true`, `attribution_method: "transcript"`, `primary_jira_ticket: <winner>`, `primary_project: <winner>`; original `jira_ticket` and `project` NOT overwritten.

**AC-23** — Given an event with `jira_ticket: "PROJ-999"` but `task` not mentioning `PROJ-999` (task-jira mismatch), when `--audit` runs, then it appears with `method=task_jira_mismatch` and `primary_jira: ""`; when `--apply`, the event gains `attribution_review_needed: true`, `attribution_method: "task_jira_mismatch"`, `primary_jira_ticket: ""`.

**AC-24** — Given no split-attribution and no task-jira mismatch, when run, then prints `"no split-attribution and no task-jira mismatch — nothing to reconcile"` and exits 0.

**AC-25** — `scripts/reconcile-session-attribution.sh` becomes 2-line bash stub; `.cmd` sibling created.

### Cross-cutting

**AC-26** — `CLAUDE.md` line about operational scripts "intentionally remain bash" is updated to cite this Phase 6 spec.

**AC-27** — `npm test` exits 0 on all three OSes via existing `cross-os-smoke.yml` matrix (paths `scripts/**`, `tests/**` already trigger it).

**Total: 27 ACs**.

## 5. Technical Design

### 5.1 Architecture

Each script is self-contained. No new `_lib/` utility is added; all five reuse existing libraries: `_lib/transcript.readTranscript`, `_lib/heuristics` (`extractTask`, `extractJiraTicket`, `looksLikeSecret`), `_lib/process.atomicWrite`, `node:child_process` `execFileSync` (for git calls), `node:readline` (for JSONL streaming).

**Scope clarification — `reconcile-session-attribution.js` vs `reconcile-session-events.js`** (Phase 2, already Node):
- `reconcile-session-events.js`: fills/corrects `task` and `jira_ticket` from CC transcripts.
- `reconcile-session-attribution.sh` (this phase): annotates events with `attribution_review_needed` flags by detecting cross-terminal attribution drift and task-jira mismatches. Does not write `task`/`jira_ticket` directly.

Both will coexist; script header comments must clearly state the distinction.

### 5.2 Per-script Mapping (bash → Node)

| Bash construct | Node replacement |
|---|---|
| `jq -c 'select((.session_id // "") == "")'` | `JSON.parse(line).session_id ?? ''` |
| `jq -cs 'group_by(.session_id) \| ...'` | In-memory `Map` keyed by `session_id` |
| `case "$sid" in ????????-...)` UUID gate | `UUID_RE.test(sid)` |
| `date -d "$ts" -u +%s` (GNU date only) | `new Date(ts).getTime()` (cross-OS) |
| `date -d "@$((ep ± delta))" -u +"%Y-%m-%dT%H:%M:%SZ"` | `new Date(epochMs ± deltaMs).toISOString()` |
| `awk 'IGNORECASE=1 { ... }'` | `name.toLowerCase()` comparison |
| `grep -oE '[A-Z]+-[0-9]+'` | `text.match(/\b[A-Z]+-[0-9]+\b/g)` |
| `grep -Fxf` set intersection | `new Set(a).has(b)` filter |
| `find … -maxdepth 2 -name … -print -quit` | `fs.readdirSync` + `path.join` + `fs.existsSync` early return |
| `mktemp` + `mv` race guard | `_lib/process.atomicWrite` (preserves line-count assertion) |
| `jq -c --slurpfile lk … '...'` single-pass rewrite | Read all lines, build `Map<lineNo, annotation>`, rewrite via `atomicWrite` |
| `git config` + `git rev-parse --show-toplevel` | `execFileSync('git', [...])` from `node:child_process` |
| `EVENTS_FILE_OVERRIDE` etc. env vars | `process.env.<NAME>` |

### 5.3 Bash Stub Pattern

All five `.sh` files convert to the 2-line pattern (matching `scripts/fresh-context:1-2`). The stub uses the literal filename to avoid ambiguity when invoked with or without `.sh`:

```
#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/audit-session-attribution.js" "$@"
```

Windows `.cmd` (matching `scripts/fresh-context.cmd:1-2`):

```
@echo off
node "%~dp0audit-session-attribution.js" %*
```

### 5.4 Timestamp Arithmetic (replaces GNU date)

```js
const ep = new Date(ts).getTime();
const from = new Date(ep - windowHours * 3_600_000).toISOString();
const to   = new Date(ep + windowHours * 3_600_000).toISOString();
```

Standard JS `Date` works on all platforms — fixes the macOS GNU coreutils latent bug as a side effect.

### 5.5 User→Email Mapping (backfill-jira-from-commits)

Two-phase, preserved from bash:
1. Walk workspace `.ai-memory/session-end-events.jsonl` git log for (name, email) pairs.
2. Walk each git repo under `agent/_projects/*/` for additional pairs.
3. Build `Map<lowerFirstName, Set<email>>` for fuzzy matching.
4. `emails_for_user(user)`: extract first token via `user.toLowerCase().split(/\s+/)[0]`, return all emails whose name starts with that token.

Done once at startup, NOT per-event (matches bash's `USER_EMAIL_MAP.expanded` optimization).

### 5.6 Dominant Ticket Algorithm

```js
function dominantTicket(ticketLines) {
  const counts = new Map();
  for (const t of ticketLines) counts.set(t, (counts.get(t) || 0) + 1);
  let maxCount = 0, winner = null, ties = 0;
  for (const [t, c] of counts) {
    if (c > maxCount) { maxCount = c; winner = t; ties = 1; }
    else if (c === maxCount) { ties++; }
  }
  return ties === 1 && winner ? { ticket: winner, count: maxCount } : null;
}
```

## 6. Cost & Performance

Not on hot path. No latency budgets. Constraint: Node port not noticeably slower than bash for typical sizes (~500–2000 events, ~10–50 git repos).

| Script | Bash | Node | Notes |
|---|---|---|---|
| `setup-merge-drivers` | < 1 s | < 1 s | 2 git config calls |
| `audit-session-attribution` | 2–10 s | < 1 s | jq fork elimination |
| `backfill-task-from-transcripts` | 5–30 s | 1–5 s | `readTranscript` per session |
| `backfill-jira-from-commits` | 30–300 s | 10–60 s | git log scan with email caching |
| `reconcile-session-attribution` | 5–60 s | 1–10 s | `find` → `readdirSync`, in-memory grouping |

## 7. Implementation Notes

**Order of porting (smallest-first reduces risk)**:

1. `setup-merge-drivers.js` — 18 lines, trivial.
2. `audit-session-attribution.js` — read-only, no write path.
3. `backfill-task-from-transcripts.js` — write path, all utilities exist.
4. `backfill-jira-from-commits.js` — most complex; git log + timestamps + email mapping.
5. `reconcile-session-attribution.js` — longest bash; algorithm maps cleanly once `readTranscript` + `BROAD_JIRA_RE` are wired.

**One commit per script** (Phase 5 discipline).

**`atomicWrite` replaces mktemp + mv + race guard.** Preserve the line-count sanity assertion in the Node port:
```js
if (originalLines.length !== newLines.length) {
  throw new Error(`line count changed ${originalLines.length} → ${newLines.length}`);
}
```

**Test fixtures**: each test creates an isolated tempdir with inline fixture data; do not share `tests/fixtures/events-mixed.jsonl` to avoid coupling.

**Git-repo tests** for `backfill-jira-from-commits.js` use `execFileSync('git', ['init', tmpDir])` + synthetic commits with `--date` flag to place them in the target window. Pattern from `tests/scripts/git-merge-jsonl-union.test.js`.

## 8. Risks & Open Questions

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R-1 | GNU `date -d` is not on macOS by default; bash backfill silently produces wrong timestamp windows | **Confirmed latent bug** | Node `Date` fixes this as a side effect of porting. |
| R-2 | `awk 'IGNORECASE=1'` is gawk-only | Low | `toLowerCase()` is portable. |
| R-3 | `find -print -quit` early exits; `readdirSync` scans full dir | Low | Early `return` once found; slug dirs are small. |
| R-4 | `backfill-jira-from-commits.js` could regress to per-user-per-repo git calls | Medium | Pre-build email→repo→commits index at startup; mirror bash's caching. |
| R-5 | `audit-session-attribution.sh` Unicode `✓` may render as `?` on some Windows terminals | Low | UTF-8 stdout works in Windows Terminal; fall back to `[OK]` if needed. |
| R-6 | Tests for `backfill-jira-from-commits.js` need real git repos in tempdirs | Medium | `execFileSync('git', ['init', ...])` + synthetic commits with `--date`. |
| R-7 | `reconcile-session-attribution` and `reconcile-session-events` confused by similar names | Low | Header docstrings call out the distinction. |

**Bugs found (file as follow-up tickets, do not fix in Phase 6)**:

- **BUG-1** (`backfill-jira-from-commits.sh:131`): `date -d "$ts"` fails silently on macOS without GNU coreutils, causing the window query to return empty. Resolved as side effect of port (R-1).

## 9. File Map

**New files (15)**:

| File | Description |
|---|---|
| `scripts/setup-merge-drivers.js` | Port of `setup-merge-drivers.sh` |
| `scripts/setup-merge-drivers.cmd` | Windows cmd stub |
| `scripts/audit-session-attribution.js` | Port: `--json` + human-readable modes |
| `scripts/audit-session-attribution.cmd` | Windows cmd stub |
| `scripts/backfill-task-from-transcripts.js` | Port; reuses `_lib/transcript` + `_lib/heuristics` |
| `scripts/backfill-task-from-transcripts.cmd` | Windows cmd stub |
| `scripts/backfill-jira-from-commits.js` | Port; git log + timestamps in JS |
| `scripts/backfill-jira-from-commits.cmd` | Windows cmd stub |
| `scripts/reconcile-session-attribution.js` | Port; split-session + task-jira mismatch |
| `scripts/reconcile-session-attribution.cmd` | Windows cmd stub |
| `tests/scripts/setup-merge-drivers.test.js` | ≥ 3 cases |
| `tests/scripts/audit-session-attribution.test.js` | ≥ 3 cases |
| `tests/scripts/backfill-task-from-transcripts.test.js` | ≥ 4 cases |
| `tests/scripts/backfill-jira-from-commits.test.js` | ≥ 4 cases |
| `tests/scripts/reconcile-session-attribution.test.js` | ≥ 4 cases |

**Modified files (7)**:

| File | Change |
|---|---|
| `scripts/setup-merge-drivers.sh` | → 2-line bash stub |
| `scripts/audit-session-attribution.sh` | → 2-line bash stub |
| `scripts/backfill-task-from-transcripts.sh` | → 2-line bash stub |
| `scripts/backfill-jira-from-commits.sh` | → 2-line bash stub |
| `scripts/reconcile-session-attribution.sh` | → 2-line bash stub |
| `CLAUDE.md` | Remove "intentionally remain bash" qualifier; cite this spec |
| `scripts/_lib/heuristics.js` | Update stale mirroring comment (lines ~11-13) |

**Deleted files**: None. The `.sh` files remain as 2-line stubs.

## Grounding Citations

- Phase 5 Non-Goals (deferred scripts): `docs/specs/spec-2026-05-06-node-port-phase-5-complete.md` §3
- Bash stub pattern: `scripts/fresh-context:1-2`
- Windows cmd stub pattern: `scripts/fresh-context.cmd:1-2`
- `atomicWrite` utility: `scripts/_lib/process.js:14-18`
- `readTranscript` utility: `scripts/_lib/transcript.js:22-75`
- `extractTask`, `extractJiraTicket`, `looksLikeSecret`: `scripts/_lib/heuristics.js:83-108`
- `BROAD_JIRA_RE` distinction (heuristics is $JIRA_PREFIX-scoped): `scripts/_lib/heuristics.js:34`
- Stale heuristics comment to update: `scripts/_lib/heuristics.js:11-13`
- Test tempdir pattern: `tests/scripts/reconcile.test.js:22-26`
- `spawnSync` test runner pattern: `tests/scripts/reconcile.test.js:15-19`
- CI already covers `scripts/**`: `.github/workflows/cross-os-smoke.yml:5-8`
- UUID validation pattern: `scripts/reconcile-session-attribution.sh:58-63`
- GNU date bug locus: `scripts/backfill-jira-from-commits.sh:131`
- Email mapping single-walk optimization: `scripts/backfill-jira-from-commits.sh:74-83`
- Sidecar drift loop to replace: `scripts/audit-session-attribution.sh:85-115`
- Task-jira mismatch classifier: `scripts/reconcile-session-attribution.sh:88-104`
- Race guard to preserve: `scripts/backfill-task-from-transcripts.sh:181-201`
