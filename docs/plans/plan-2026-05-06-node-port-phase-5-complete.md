# Implementation Plan — Phase 5: Complete the Node Port

**Date**: 2026-05-06
**Spec**: [docs/specs/spec-2026-05-06-node-port-phase-5-complete.md](../specs/spec-2026-05-06-node-port-phase-5-complete.md) (26 ACs)
**Branch**: `feat/node-port-phase-5-complete` (base: `feat/node-port-phase-4-jsonl-merge`; auto-rebases as upstream phases merge)
**Status**: Approved — ready for `/swarm-implement`

---

## Context

Six hooks in `.claude/settings.json` still invoke `.sh` files (`PreToolUse`, `PostToolUse`, `SessionStart`, `SubagentStop`, `PreCompact`, `Notification`). Windows users hit immediate failures; CI cannot exercise hook logic on `windows-latest`. Additionally, `user-prompt-dispatcher.js:100-113` forks `inject-context.sh` via `execFileSync` with a confirmed empty-stdin defect — `~/.ai-memory/dispatcher-debug.jsonl` shows `rawLen: 0` for every `UserPromptSubmit`, so sidecar writes and the `prompts` counter never fire.

Phase 5 is the closing port: eliminates `bash`/`jq` from the hot path, fixes the dispatcher defect via in-process `inject-context-impl.run(...)` with a triple-fallback `readStdin()`, deletes the deprecated `session-stop.sh`, expands the cross-OS CI matrix, deprecates WSL, and updates `CLAUDE.md`.

---

## Task list (14 tasks)

| ID | Task | Owner files | Deps | Est. | ACs |
|----|------|-------------|------|------|-----|
| **T1** | Extract `fresh-context-impl.js` (`run()`); refactor `fresh-context.js` to thin wrapper. Existing Phase 3 tests must still pass. | `scripts/fresh-context-impl.js` (new), `scripts/fresh-context.js` (refactor), `tests/scripts/fresh-context.test.js` | — | 1.5h | enables AC-16 (R-1) |
| **T2** | Extend `heuristics.js` with shell-secret patterns (`KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=` raw assignments). | `scripts/_lib/heuristics.js`, `tests/_lib/heuristics.test.js` | — | 0.5h | enables AC-7 |
| **T3** | Port `inject-context.sh` (408 lines) → `inject-context-impl.js` (exports `run()`) + standalone wrapper `inject-context.js`. **Critical-path long pole.** | `scripts/hooks/inject-context-impl.js` (new), `scripts/hooks/inject-context.js` (new), `tests/hooks/inject-context.test.js` (new) | — | 5h | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 |
| **T4** | Port `pre-tool-use.sh` → `pre-tool-use.js`. Reads stdin; uses extended `heuristics.js` patterns. | `scripts/hooks/pre-tool-use.js` (new), `tests/hooks/pre-tool-use.test.js` (new) | T2 | 1.5h | AC-7, AC-8, AC-9 |
| **T5** | Port `post-tool-use.sh` → `post-tool-use.js`. Reads `CLAUDE_TOOL_NAME`/`CLAUDE_TOOL_INPUT` env vars; appends to `.ai-memory/audit/YYYY-MM-DD.log`. | `scripts/hooks/post-tool-use.js` (new), `tests/hooks/post-tool-use.test.js` (new) | — | 1h | AC-10, AC-11 |
| **T6** | Port `session-start.sh` → `session-start.js`. Writes `.ai-session/cc-session-id` via `atomicWrite`. | `scripts/hooks/session-start.js` (new), `tests/hooks/session-start.test.js` (new) | — | 0.75h | AC-12, AC-13 |
| **T7** | Port `pre-compact.sh` → `pre-compact.js`. In-process `require('./fresh-context-impl').run(...)` call. | `scripts/hooks/pre-compact.js` (new), `tests/hooks/pre-compact.test.js` (new) | T1 | 1h | AC-16 |
| **T8** | Dispatcher refactor: remove `execFileSync` import + `runInjectContext` subprocess call; in-process `injectContextImpl.run(...)`; triple-fallback `readStdin()` (fd 0 → `/dev/stdin` → `process.stdin` drain). | `scripts/hooks/user-prompt-dispatcher.js` | T3 | 1.5h | AC-19, AC-20 |
| **T9** | Port `subagent-stop.sh` → `subagent-stop.js`. Appends JSONL to `.claude/logs/subagent-events.jsonl`. | `scripts/hooks/subagent-stop.js` (new), `tests/hooks/subagent-stop.test.js` (new) | — | 1h | AC-14, AC-15 |
| **T10** | Port `notify.sh` → `notify.js`. Appends JSONL to `.claude/logs/notifications.jsonl`. | `scripts/hooks/notify.js` (new), `tests/hooks/notify.test.js` (new) | — | 0.75h | AC-17, AC-18 |
| **T11** | Wiring: update all six hook commands in `.claude/settings.json` to `node ./scripts/hooks/<name>.js`; delete 7 hook bash files + `session-stop.sh` (8 total) + `.ai-session/cc-session-id` + `.ai-session/hook-session-id`; add `.gitignore` entries for the two state files. | `.claude/settings.json`, `.gitignore`, deletes per spec §9 | T3,T4,T5,T6,T7,T8,T9,T10 | 0.5h | AC-21, AC-22, AC-26 |
| **T12** | Expand CI matrix: add new hook globs + `tests/hooks/**` to `paths` trigger in `cross-os-smoke.yml`. | `.github/workflows/cross-os-smoke.yml` | T11 | 0.5h | AC-23 |
| **T13** | Docs: create `docs/wsl-deprecation.md`; update `CLAUDE.md` (remove `.sh` hook refs, add Node-port-complete marker citing Phases 1–5). | `docs/wsl-deprecation.md` (new), `CLAUDE.md` | T11 | 1h | AC-24, AC-25 |
| **T14** | Smoke + live verify: `npm test` local; submit a real `UserPromptSubmit` and assert sidecar `prompts` advances and `dispatcher-debug.jsonl` records `rawLen > 0`; reviewer agent reviews all 26 ACs; cross-OS CI matrix green on all three legs. | none (read-only/test) | T11,T12,T13 | 1.5h | all (gate) |

**Critical path**: T3 (5h) → T8 (1.5h) → T11 (0.5h) → T12∥T13 (max 1h) → T14 (1.5h) = **9.5h**.

---

## Wave plan — 6 waves, peak 5-way concurrency

### Wave 1 — 4 parallel (foundations + long pole)
| Teammate | Agent | Task |
|----------|-------|------|
| `fresh-context-impl-extractor` | implementer | T1 |
| `heuristics-shell-secret` | implementer | T2 |
| `inject-context-impl` | implementer | T3 (long pole, ~5h) |
| `session-start-impl` | implementer | T6 |

**Sync gate (soft)**: Wave 2 can fan out the moment T1+T2 commits land (~t=1.5h). T3 keeps running through Wave 2.

### Wave 2 — 5 parallel (peak concurrency)
| Teammate | Agent | Task |
|----------|-------|------|
| `pre-tool-use-impl` | implementer | T4 (after T2) |
| `post-tool-use-impl` | implementer | T5 |
| `pre-compact-impl` | implementer | T7 (after T1) |
| `subagent-stop-impl` | implementer | T9 |
| `notify-impl` | implementer | T10 |

**Sync gate**: Wait for T3 commit before Wave 3.

### Wave 3 — 1 (depends on T3)
| Teammate | Agent | Task |
|----------|-------|------|
| `dispatcher-refactor` | implementer | T8 (verifies the empty-stdin bug fix) |

### Wave 4 — 1 (depends on T3–T10)
| Teammate | Agent | Task |
|----------|-------|------|
| `wiring-impl` | implementer | T11 (settings.json + 10 deletes + .gitignore) |

### Wave 5 — 2 parallel (depends on T11)
| Teammate | Agent | Task |
|----------|-------|------|
| `ci-matrix-expand` | implementer | T12 |
| `docs-impl` | implementer | T13 |

### Wave 6 — Reviewer + Smoke
| Teammate | Agent | Task |
|----------|-------|------|
| `phase5-reviewer` | reviewer | Pre-merge review against all 26 ACs |
| `phase5-smoke` | tester | T14 (npm test + live empty-stdin verify + CI gate) |

---

## Wall-clock estimate

| Time | Event |
|------|-------|
| t=0 | Wave 1 starts: T1, T2, T3, T6 |
| t=0.5h | T2 done |
| t=0.75h | T6 done |
| t=1.5h | T1 done → Wave 2 fans out (T4, T5, T7, T9, T10) |
| t=3h | Wave 2 complete |
| t=5h | T3 done → Wave 3 (T8) |
| t=6.5h | T8 done → Wave 4 (T11) |
| t=7h | T11 done → Wave 5 (T12 ∥ T13) |
| t=8h | Wave 5 done → Wave 6 (reviewer + T14) |
| t=10h | T14 done; PR opened; CI gate |
| **Total** | **~10 h elapsed** vs ~17 h serial |

---

## Verification

### Local
1. `npm test` — target ≈ 140 tests (113 baseline + ~27 new hook + heuristics cases). All green.
2. `node --check` on every new `.js` file (8 hook files + `fresh-context-impl.js`).
3. Hook latency p95 within `settings.json` budgets:
   - Dispatcher (`UserPromptSubmit`) < 200 ms (down from ≈ 350 ms with `execFileSync` fork).
   - Each hook < its individual timeout (Spec §6 table).

### Live empty-stdin fix verification (T14, defends the dispatcher bug)
1. Tail `~/.ai-memory/dispatcher-debug.jsonl`.
2. Submit a real prompt in a fresh CC session.
3. Assert `rawLen > 0` for that invocation.
4. Read `.ai-session/by-id/<session>.json`; assert `prompts` advanced from prior value.

### CI (AC-23)
- `cross-os-smoke.yml` matrix green on `ubuntu-latest`, `macos-latest`, `windows-latest`.

---

## Reused utilities (`scripts/_lib/`)

| Utility | Used by |
|---------|---------|
| `process.js` → `atomicWrite` | T3 (sidecar writes), T6 (`cc-session-id` write) |
| `heuristics.js` → `looksLikeSecret`, `SECRET_RE` | T4 (secret detection) |
| `heuristics.js` → `extractJiraTicket` | T3 (Jira priority chain in inject-context-impl) |
| `workspace-root.js` → `findWorkspaceRoot` | T3 (impl receives workspaceRoot from caller) |

---

## Risks (carried from spec §8)

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | `fresh-context.js` does not export `run()` | Confirmed; T1 extracts impl as first commit |
| R-2 | `pre-tool-use.sh` reads stdin (not env) | Confirmed; `pre-tool-use.js` mirrors |
| R-3 | `CLAUDE_TOOL_INPUT` env var not valid JSON on some CC versions | T5 wraps `JSON.parse` in try/catch with regex fallback |
| R-4 | Windows path separators in cc-JSONL `custom-title` slug | T3 uses `userCwd.replace(/[\\/]/g, '-')` and tests on `windows-latest` |
| R-5 | `readFileSync(0)` returns empty on Windows | T8 chains fd 0 → `/dev/stdin` → `process.stdin` drain; falls back to AC-3 no-op if all fail |
| R-6 | `find -mtime` semantics differ on Windows | T3 uses `Date.now() - stat.mtimeMs > 7 * 86400_000` |

---

## Out of scope (spec §3)

- Operational one-shot scripts (audit/backfill/reconcile/setup-merge-drivers) stay bash.
- `token-dashboard.sh` defer; TS dashboard is the long-term replacement.
- CC hook protocol or payload schema changes.
- `agent/_phases/`, `agent/_core/`, `.claude/agents/` modifications.
- Hook timeout budget changes in `settings.json`.
- Desktop notification integration in `notify.js`.
- Bash wrapper stubs for the six hooks (settings.json updated directly).

---

## Execute

```bash
/swarm-implement docs/plans/plan-2026-05-06-node-port-phase-5-complete.md
```
