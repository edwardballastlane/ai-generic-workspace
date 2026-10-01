# Implementation Plan — Phase 6: Operational One-Shot Scripts

**Date**: 2026-05-06
**Spec**: [docs/specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md](../specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md) (27 ACs)
**Branch**: `feat/node-port-phase-6-operational-scripts` (base: `feat/node-port-phase-5-complete`; auto-rebases to master once Phase 5 merges)
**Status**: Approved — ready for `/swarm-implement`

---

## Context

Phase 5 §3 deferred 5 operational one-shot scripts as "intentionally remain bash" — but this leaves Windows users unable to run `setup-merge-drivers` (needed at clone time) and silently produces wrong timestamp windows on macOS without GNU coreutils (`date -d` is GNU-only). User reversed the deferral; Phase 6 ports all 5 scripts to Node 20+, fixes the macOS bug as a side effect, and removes the stale CLAUDE.md note.

Phase 6 inherits Phase 5's CI fixes (`run-tests.js` cross-OS test discovery, `git` installed in Bitbucket Pipelines). Phase 6 starts a stacked PR on Phase 5 (which is currently in PR #5 awaiting CI green + merge).

---

## Task list (7 tasks)

| ID | Task | Owner files | Deps | Est. | ACs |
|----|------|-------------|------|------|-----|
| **T1** | Port `setup-merge-drivers.sh` (18 lines) → `setup-merge-drivers.js`. Calls `git config` via `execFileSync`. Add bash stub + .cmd sibling + tests. | `scripts/setup-merge-drivers.{js,cmd,sh}`, `tests/scripts/setup-merge-drivers.test.js` | — | 0.5h | AC-1, AC-2, AC-3, AC-4 |
| **T2** | Port `audit-session-attribution.sh` (159 lines) → `audit-session-attribution.js`. `--json` + human-readable modes; in-memory JSONL pass; sidecar drift check. | `scripts/audit-session-attribution.{js,cmd,sh}`, `tests/scripts/audit-session-attribution.test.js` (≥3 cases) | — | 2h | AC-5, AC-6, AC-7, AC-8, AC-9, AC-10 |
| **T3** | Port `backfill-task-from-transcripts.sh` (205 lines) → `backfill-task-from-transcripts.js`. Reuses `_lib/transcript.readTranscript`, `_lib/heuristics.{extractTask, extractJiraTicket, looksLikeSecret}`, `_lib/process.atomicWrite`. | `scripts/backfill-task-from-transcripts.{js,cmd,sh}`, `tests/scripts/backfill-task-from-transcripts.test.js` (≥4 cases) | — | 2.5h | AC-11, AC-12, AC-13, AC-14, AC-15 |
| **T4** | Port `backfill-jira-from-commits.sh` (331 lines) → `backfill-jira-from-commits.js`. **Critical-path long pole.** Replaces GNU `date -d` with JS `Date` (fixes macOS BUG-1). Local `BROAD_JIRA_RE = /\b[A-Z]+-[0-9]+\b/g`. Two-phase email mapping at startup. | `scripts/backfill-jira-from-commits.{js,cmd,sh}`, `tests/scripts/backfill-jira-from-commits.test.js` (≥4 cases) | — | 5h | AC-16, AC-17, AC-18, AC-19, AC-20 |
| **T5** | Port `reconcile-session-attribution.sh` (339 lines) → `reconcile-session-attribution.js`. `find` → `readdirSync`; in-memory split-session detection; `BROAD_JIRA_RE` for task-jira mismatch; `pickPrimaryJira` with `transcript`/`majority` methods. | `scripts/reconcile-session-attribution.{js,cmd,sh}`, `tests/scripts/reconcile-session-attribution.test.js` (≥4 cases) | — | 4h | AC-21, AC-22, AC-23, AC-24, AC-25 |
| **T6** | Cross-cutting cleanup: update `CLAUDE.md` to remove "intentionally remain bash" qualifier and cite Phase 6 spec; update `scripts/_lib/heuristics.js:11-13` stale mirroring comment. | `CLAUDE.md`, `scripts/_lib/heuristics.js` | T1, T2, T3, T4, T5 | 0.5h | AC-26 |
| **T7** | Smoke + reviewer: `npm test`; `node --check` on every new `.js`; reviewer reviews against all 27 ACs; AC-23 cross-OS CI gate confirmed; clean `git status`. | none (read-only/test) | T6 | 1.5h | gate for all 27 (AC-27) |

**Critical path**: T4 (5h) → T6 (0.5h) → T7 (1.5h) = **7h**.

All 5 ports (T1-T5) are independent — no inter-deps. Wave 1 fires all 5 at once.

---

## Wave plan — 3 waves, peak 5-way concurrency

### Wave 1 — 5 parallel implementers (peak)
| Teammate | Agent | Task |
|----------|-------|------|
| `setup-merge-drivers-impl` | implementer | T1 (smallest, 0.5h) |
| `audit-session-attribution-impl` | implementer | T2 (2h) |
| `backfill-task-impl` | implementer | T3 (2.5h) |
| `backfill-jira-impl` | implementer | T4 (5h, long pole) |
| `reconcile-attribution-impl` | implementer | T5 (4h) |

**Sync gate**: Wait for ALL 5 commits before Wave 2.

### Wave 2 — 1 sequential (depends on T1-T5)
| Teammate | Agent | Task |
|----------|-------|------|
| `cleanup-impl` | implementer | T6 (CLAUDE.md + heuristics.js comment) |

### Wave 3 — Reviewer + Smoke (parallel)
| Teammate | Agent | Task |
|----------|-------|------|
| `phase6-reviewer` | reviewer | All 27 ACs review |
| `phase6-smoke` | tester | T7 (npm test + node --check + AC mapping) |

---

## Wall-clock estimate

| Time | Event |
|------|-------|
| t=0 | Wave 1 starts: T1, T2, T3, T4, T5 in parallel |
| t=0.5h | T1 done |
| t=2h | T2 done |
| t=2.5h | T3 done |
| t=4h | T5 done |
| t=5h | T4 done → Wave 2 (T6) starts |
| t=5.5h | T6 done → Wave 3 starts |
| t=7h | Done; ready for `/pre-push` |
| **Total** | **~7 h elapsed** vs ~14.5 h serial |

---

## Verification

### Local
1. `npm test` — target ≈ 200 tests (170 baseline + ~22 new). All green.
2. `node --check` on 5 new `.js` files.
3. Each `--audit` mode runs without throwing on the real workspace.
4. **AC-1**: `node scripts/setup-merge-drivers.js` from temp git repo registers `merge.jsonl-union.driver` correctly.

### CI (AC-23)
- `cross-os-smoke.yml` matrix gates merge on `ubuntu-latest`, `macos-latest`, `windows-latest`. Phase 5 already broadened `paths` to `scripts/**` — no CI changes needed in Phase 6.

---

## Reused utilities (`scripts/_lib/`)

| Utility | Used by |
|---------|---------|
| `transcript.js` → `readTranscript` | T3, T5 |
| `heuristics.js` → `extractTask`, `extractJiraTicket`, `looksLikeSecret` | T3 |
| `process.js` → `atomicWrite` | T3, T4, T5 |
| `workspace-root.js` → `findWorkspaceRoot` | all 5 |
| `node:child_process` `execFileSync` | T1, T4 |
| `node:readline` (JSONL streaming) | T2, T3, T4, T5 |

---

## Constraints — non-negotiable

1. CommonJS only: `'use strict';`, `module.exports`, `require()`.
2. `node:` prefix on all stdlib imports.
3. No new dependencies — reuse `_lib/` only.
4. `atomicWrite` for cross-process writes; preserve line-count assertion before write.
5. No GNU `date -d` — use JS `Date` (fixes macOS BUG-1).
6. No `find` / `mtime` shell builtins — `fs.readdirSync` + `path.join` + `fs.existsSync`.
7. `BROAD_JIRA_RE = /\b[A-Z]+-[0-9]+\b/g` is **local** to T4 + T5; do NOT widen `heuristics.extractJiraTicket` (stays $JIRA_PREFIX-scoped).
8. Bash stubs: 2-line `exec node` delegator with literal filename.
9. `.cmd` siblings: `@echo off\nnode "%~dp0<name>.js" %*`.
10. Commit footers cite ACs: `Closes AC-X, AC-Y`.

---

## Risks (carried from spec §8)

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | GNU `date -d` not on macOS by default — bash silently wrong | Node `Date` fixes as side effect of port |
| R-3 | `find -print -quit` early exit; `readdirSync` scans full | Early `return` once found; slug dirs are small |
| R-4 | Per-event git log calls regress to slow path | Build email→repo→commits index at startup |
| R-5 | Unicode `✓` may render as `?` on some Windows terminals | UTF-8 stdout works in Windows Terminal; fall back to `[OK]` if needed |
| R-6 | Tests for T4 need real git repos | Tempdir + `git init` + synthetic commits with `--date` |
| R-7 | `reconcile-session-attribution.js` vs `reconcile-session-events.js` naming confusion | Header docstring on each clarifies scope |

---

## Out of scope (spec §3)

- `token-dashboard.sh` — TS dashboard is canonical replacement.
- CC hook protocol / `session-end-events.jsonl` schema changes.
- `agent/_phases/`, `agent/_core/`, `.claude/agents/` modifications.
- Hook timeout budget changes.
- Bug fixes in bash originals (only macOS `date -d` exception).
- Widening `extractJiraTicket` beyond `$JIRA_PREFIX-NNN` (use local `BROAD_JIRA_RE`).
- Hot-path performance — these scripts run once per incident.

---

## Execute

```bash
/swarm-implement docs/plans/plan-2026-05-06-node-port-phase-6-operational-scripts.md
```
