# Implementation Plan — Phase 3: User-Facing Scripts Node Port

**Spec**: `docs/specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md`
**Branch (planned)**: `feat/node-port-phase-3-user-facing-scripts` (base: `master`, after Phase 2 merges)
**Repo**: `<workspace-root>`

---

## Context

Phase 1 ported the session-stop hook; Phase 2 improves task summary quality. Phase 3 completes the cross-platform story by porting the four user-facing bash scripts (`fresh-context`, `list-projects`, `add-project`, `statusline`) that still depend on `jq`, `yq`, `python3`, and `awk`. Without this phase, Windows support is blocked and `statusline` cold-start degrades as transcripts grow. The spec contains **22 ACs** (original 17 + cross-OS hardening 18-22) across 5 areas (4 scripts + cross-cutting), covers ~1,125 source lines of bash to port to ~930 lines of Node.js, and adds ~4 test files plus a fixture (estimated ~38 new test cases on top of the current 59). **CI gate (AC-22): cross-os-smoke matrix must be green on ubuntu/macos/windows before merge.**

**On approval, this plan will be saved to `docs/plans/plan-2026-05-06-node-port-phase-3-user-facing-scripts.md`** alongside an optional `wave-planner --json` variant, then the user can run `/swarm-implement <plan>` to execute.

---

## Tasks

### Wave 1 — Independent (4 tasks, fully parallel)

#### T1: Extend `transcript.js` with `lastUsage` (foundation for T5)

Add `let lastUsage = null` inside the existing readline loop; set it on every usage-bearing row (last write wins); return it in the result object. 5-line additive change.

- **Files modified**: `scripts/_lib/transcript.js`
- **Tests modified**: `tests/_lib/transcript.test.js` — add 2 cases: (a) `lastUsage` is the final usage block when multiple usage rows exist, (b) `lastUsage` is `null` when transcript has no usage rows
- **Dependencies**: none
- **ACs**: OQ-4 (spec §6.1); AC-12 indirectly (consumed in T5)
- **Effort**: 0.5 h

#### T2: Implement `scripts/list-projects.js`

Port `list-projects` (155 bash lines → ~150 Node lines). Inline `parseSimpleYaml` (extracts `platform` from `.ai-config/settings.yaml`; `language` from `.ai-contexts/<name>.yaml`). `Promise.all` over project entries for parallel `git remote get-url` via async `execFile`. `fs.lstatSync` identifies both Unix symlinks AND Windows junctions (Node 20+ `isSymbolicLink()` returns true for both — verified by AC-21 test). Exit 1 with "Setup Required" when `.ai-config/settings.yaml` absent. **Color helper** `pickColors()` returns 16-color fallback when `process.platform === 'win32' && !process.env.WT_SESSION` (AC-20). Set executable bit via `fs.chmodSync(__filename, 0o755)` once at startup (AC-19).

- **Files created**: `scripts/list-projects.js`, `tests/scripts/list-projects.test.js`
- **Dependencies**: none
- **ACs**: AC-5, AC-6, AC-7, AC-19, AC-20, AC-21 (link detection)
- **Effort**: 2.5 h

#### T3: Implement `scripts/fresh-context.js`

Port `fresh-context` (248 bash lines → ~200 Node lines). Inline `parseSimpleYaml` for `current.yaml` (keys: `workflow`, `phase`, `phase_name`, `agent`, `refined`, `original`, `status`). Sidecar priority: `--session-id` arg > `CLAUDE_SESSION_ID` env > most-recent by mtime. `fs.writeFileSync` for `latest.md` (plain copy, not symlink). Prune oldest beyond 20 by mtime. `--print` and `--latest` modes. Cost line conditional on `costUsd > 0`.

- **Files created**: `scripts/fresh-context.js`, `tests/scripts/fresh-context.test.js`
- **Dependencies**: none
- **ACs**: AC-1, AC-2, AC-3, AC-4, AC-19 (chmod)
- **Effort**: 3 h

#### T4: Implement `scripts/add-project.js`

Port `add-project` (367 bash lines → ~280 Node lines). Platform detection order: GitHub/Bitbucket/GitLab/Azure URL patterns first, then local path heuristics (`/`, `~/`, `./` prefix, or `fs.existsSync`), then new-project name. `expandHome` with `os.homedir()`. `fs.symlinkSync(target, dest, 'junction')` on win32, `'dir'` elsewhere. `fs.cpSync` for `--copy`. `execFileSync('git', [...])` for clone/init (no shell). Git-block strip via `inGit` flag loop (fixes bash `sed` EOF bug). `lane.code-workspace` update via `JSON.parse/stringify` + `atomicWrite`. **AC-21 test**: create a junction (Win32) or symlink (POSIX) in tempdir, assert `fs.lstatSync(...).isSymbolicLink() === true` on both platforms.

- **Files created**: `scripts/add-project.js`, `tests/scripts/add-project.test.js`
- **Dependencies**: none (uses stable `atomicWrite` from `_lib/process.js`)
- **ACs**: AC-8, AC-9, AC-10, AC-11, AC-19 (chmod), AC-21 (link creation)
- **Effort**: 4.5 h

### Wave 2 — Depends on T1

#### T5: Implement `scripts/statusline.js`

Port `statusline` (355 bash lines → ~300 Node lines). Consumes `readTranscript().lastUsage` from T1 to eliminate both `jq` calls on the transcript. Entry point: accumulate stdin then `main(raw)` in `try/catch { stdout.write('\n') }`. `DEBUG_STATUSLINE=1` logs elapsed ms to stderr. Color gate: `USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR`. CTX% from `t.lastUsage`; zones: critical ≥ 85%, warning ≥ 60%. Sidecar write-back via `atomicWrite` only when `curCost !== incomingCost`. Inline helpers: `fmtTokens`, `shortModel`, `timeFmt`. Git branch + porcelain via `execFileSync`.

- **Files created**: `scripts/statusline.js`, `tests/scripts/statusline.test.js`, `tests/fixtures/statusline-input.json`
- **Dependencies**: T1 (imports updated `readTranscript`)
- **ACs**: AC-12, AC-13, AC-14, AC-15, AC-19 (chmod), AC-20 (16-color fallback on Windows non-WT)
- **Effort**: 4.5 h

### Wave 3 — Depends on T2, T3, T4, T5

#### T6: Replace bash originals with wrapper stubs + add `.cmd` siblings + update `settings.json`

Four bash scripts replaced with 2-line stubs (Git Bash / WSL / POSIX path):
```bash
#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/$(basename "$0").js" "$@"
```

Four NEW `.cmd` siblings added for native Windows shells (cmd.exe / PowerShell) per AC-18:
```cmd
@echo off
node "%~dp0%~n0.js" %*
```

Update `.claude/settings.json` `statusLine.command` from `"./scripts/statusline"` to `"node ./scripts/statusline.js"`.

- **Files modified**: `scripts/fresh-context`, `scripts/list-projects`, `scripts/add-project`, `scripts/statusline`, `.claude/settings.json`
- **Files created**: `scripts/fresh-context.cmd`, `scripts/list-projects.cmd`, `scripts/add-project.cmd`, `scripts/statusline.cmd`
- **Dependencies**: T2, T3, T4, T5 — stubs are no-ops until the `.js` files exist
- **ACs**: AC-16, AC-17, AC-18 (cmd siblings)
- **Effort**: 1 h

### Wave 4 — Depends on T6

#### T7: Cross-OS CI gate + smoke verification

**CI gate (AC-22)**: open the Phase 3 PR; confirm `.github/workflows/cross-os-smoke.yml` runs `npm test` and exits 0 on `ubuntu-latest`, `macos-latest`, AND `windows-latest`. If `cross-os-smoke.yml` does not already pick up the new `tests/scripts/*.test.js` files (it should, via `node --test 'tests/**/*.test.js'`), update its glob. Any unavoidably-OS-specific test gates with `t.skip(process.platform === 'win32', ...)` or `t.skip(process.platform !== 'win32', ...)` rather than failing the wrong platform.

**Smoke verification (AC-1 through AC-21)**: run the smoke suite locally on the dev box. The statusline rendering check requires a live Claude Code session — record the result. No code changes if everything passes.

- **Files modified**: possibly `.github/workflows/cross-os-smoke.yml` if its glob misses new tests
- **Dependencies**: T6
- **ACs**: all 22 ACs exercised end-to-end (AC-22 is the CI-pass gate)
- **Effort**: 1.5 h

---

## Wave Plan

| Wave | Tasks | Concurrency | Cumulative time (1 dev + subagents) |
|------|-------|-------------|--------------------------------------|
| 1 | T1, T2, T3, T4 | 4-way parallel | ~4.5 h (T4 long pole) |
| 2 | T5 | sequential | ~9 h |
| 3 | T6 | sequential | ~10 h |
| 4 | T7 | sequential | ~11.5 h |
| **Total** | **7 tasks** | **max 4 parallel** | **~11.5 h elapsed** |

With `/swarm-implement` Wave 1 collapses to ~4.5 h elapsed (T4 bottleneck). T5 is the next long pole at 4.5 h. Cross-OS hardening adds ~2 h vs. the original estimate.

---

## Suggested Team Config for `/swarm-implement`

| Teammate | Role | Owns | Tasks |
|----------|------|------|-------|
| `implementer-transcript` | developer, TDD | `transcript.js`, `list-projects.js` | T1, T2 |
| `implementer-fresh` | developer | `fresh-context.js` | T3 |
| `implementer-addproject` | developer | `add-project.js` | T4 |
| `implementer-statusline` | developer (after Wave 1) | `statusline.js`, fixture | T5 |
| `implementer-wiring` | developer | stubs, `settings.json` | T6 |
| `smoke-runner` | tester/ops | manual verification | T7 |

Wave 1: `implementer-transcript`, `implementer-fresh`, `implementer-addproject` run concurrently. `implementer-statusline` starts only after T1 completes. `implementer-wiring` starts only after T2–T5 complete.

---

## File Ownership Matrix

| File | Tasks that touch it | Owner | Wave |
|------|---------------------|-------|------|
| `scripts/_lib/transcript.js` | T1 | implementer-transcript | 1 |
| `tests/_lib/transcript.test.js` | T1 (extend) | implementer-transcript | 1 |
| `scripts/list-projects.js` | T2 (create) | implementer-transcript | 1 |
| `tests/scripts/list-projects.test.js` | T2 (create) | implementer-transcript | 1 |
| `scripts/fresh-context.js` | T3 (create) | implementer-fresh | 1 |
| `tests/scripts/fresh-context.test.js` | T3 (create) | implementer-fresh | 1 |
| `scripts/add-project.js` | T4 (create) | implementer-addproject | 1 |
| `tests/scripts/add-project.test.js` | T4 (create) | implementer-addproject | 1 |
| `scripts/statusline.js` | T5 (create) | implementer-statusline | 2 |
| `tests/scripts/statusline.test.js` | T5 (create) | implementer-statusline | 2 |
| `tests/fixtures/statusline-input.json` | T5 (create) | implementer-statusline | 2 |
| `scripts/fresh-context` (bash) | T6 (stub) | implementer-wiring | 3 |
| `scripts/list-projects` (bash) | T6 (stub) | implementer-wiring | 3 |
| `scripts/add-project` (bash) | T6 (stub) | implementer-wiring | 3 |
| `scripts/statusline` (bash) | T6 (stub) | implementer-wiring | 3 |
| `scripts/fresh-context.cmd` | T6 (create) | implementer-wiring | 3 |
| `scripts/list-projects.cmd` | T6 (create) | implementer-wiring | 3 |
| `scripts/add-project.cmd` | T6 (create) | implementer-wiring | 3 |
| `scripts/statusline.cmd` | T6 (create) | implementer-wiring | 3 |
| `.claude/settings.json` | T6 (modify) | implementer-wiring | 3 |
| `.github/workflows/cross-os-smoke.yml` | T7 (verify, possibly tweak glob) | smoke-runner | 4 |

No file is touched by two tasks in the same wave. `transcript.js` is modified in Wave 1 (T1) and imported in Wave 2 (T5) — safe across the sync point.

---

## Verification

**Automated:**
- `npm test` — current 59 passing; expect 59 + 2 (T1) + ~9 (T2: includes color-fallback + chmod-bit + lstat-junction tests) + ~9 (T3) + ~11 (T4: includes link-creation lstat test) + ~8 (T5: includes color-fallback test) = **~98 passing** tests on each OS.
- **CI gate (AC-22)**: `cross-os-smoke.yml` exits 0 on `ubuntu-latest`, `macos-latest`, AND `windows-latest`. Phase 3 PR cannot merge until all three matrix legs are green.

**Smoke (after T6):**
```bash
node ./scripts/fresh-context.js --print
node ./scripts/list-projects.js
node ./scripts/add-project.js /tmp/test-smoke-proj && ls -la agent/_projects/test-smoke-proj
echo '{"session_id":"","transcript_path":"","model":{"id":"claude-sonnet-4-6"},"cost":{"total_cost_usd":0}}' \
  | NO_COLOR=1 node ./scripts/statusline.js
./scripts/fresh-context --print  # wrapper stub forward
```

**Manual (cannot be automated):**
- Fresh Claude Code session — confirm statusline renders without error after `.claude/settings.json` update.
- `DEBUG_STATUSLINE=1` logs elapsed ms.
- On macOS/Linux: `agent/_projects/<name>` from `add-project.js` is a symlink.
- `fs.lstatSync('.ai-session/resume/latest.md').isSymbolicLink() === false` after `fresh-context.js` runs.
- `scripts/hooks/pre-compact.sh` continues to produce snapshots after stub replaces bash original (caller compat).

---

## Risks & Open Items

| Risk | Impact | Mitigation |
|------|--------|------------|
| `readTranscript` > 200 ms on large transcripts | AC-12 fails | `DEBUG_STATUSLINE=1` profiling built in; tail fast-path deferred per spec |
| `parseSimpleYaml` misparses values with interior colons (`refined: "fix: PROJ-123"`) | Wrong workflow section in `fresh-context` | Strip outer quotes in regex capture; Lane writers always quote these |
| T5 starts before T1 merges | `lastUsage` undefined at import; tests fail | Enforce Wave 2 gate — T5 branch rebases on T1 commit |
| Wrapper stub `exec` on Git Bash / MSYS2 | AC-16 covers POSIX shells | `.cmd` siblings (AC-18) cover cmd.exe / PowerShell — full Windows-shell coverage |
| `fs.cpSync` requires Node 16.7+ | T4 `--copy` throws | Node 20+ already enforced by Phase 1 |
| 24-bit truecolor not supported on legacy cmd.exe | Garbled escape sequences | `pickColors()` falls back to 16-color when `process.platform === 'win32' && !WT_SESSION` (AC-20) |
| `cross-os-smoke.yml` glob misses new tests | Phase 3 tests not run on Windows in CI | T7 verifies and tweaks glob if needed; the gate itself catches any drift |
| CRLF line endings on git-cloned repos (Windows) | `add-project.js` reads/writes get mangled | Out of scope — deferred to Phase 4 (`.gitattributes` `eol=lf`); test fixtures use `Buffer` comparisons not string-line comparisons where it matters |

---

## Out-of-Scope Reminders (spec §3, verbatim)

- Porting other bash hooks (`pre-tool-use.sh`, `post-tool-use.sh`, `session-start.sh`, `subagent-stop.sh`, `pre-compact.sh`, `notify.sh`) — deferred.
- Porting `git-merge-jsonl-union.sh` or other `.sh` files in `scripts/` — Phase 4.
- Modifying `agent/_phases/`, `.claude/agents/`, or any hook not listed above.
- Changing the schema of `.ai-session/current.yaml` or `.ai-contexts/*.yaml` — back-compat required.
- Symlink permission elevation on Windows — junctions sidestep UAC.
- Porting `scripts/perm` — not in scope.
- Redesigning visual output of any script — output parity required.

---

## Output artifacts (saved on plan approval)

- `docs/plans/plan-2026-05-06-node-port-phase-3-user-facing-scripts.md` (this plan, source of truth)
- Optional `docs/plans/plan-2026-05-06-node-port-phase-3-user-facing-scripts.json` via `./scripts/wave-planner --json` (skip if the script doesn't accept this input format)

After approval, run `/swarm-implement <plan-path>` to execute.
