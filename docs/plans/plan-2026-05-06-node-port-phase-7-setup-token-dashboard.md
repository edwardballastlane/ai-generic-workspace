# Implementation Plan — Phase 7: Bootstrap + Token Dashboard Node Port

**Date**: 2026-05-06
**Spec**: [docs/specs/spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md](../specs/spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md) (19 ACs)
**Branch**: `feat/node-port-phase-7-setup-token-dashboard` (HEAD `8db00d9`, base: Phase 6 tip; auto-rebases as upstream phases merge)
**Status**: Approved — ready for `/swarm-implement`

---

## Context

Two bash scripts fell outside Phases 1–6:

1. `scripts/setup` (321 lines, **8** `read -p` prompts) — the **first instruction the README gives a new developer** (`README.md:32`). Windows users still need bash to follow it, contradicting Phase 5's "WSL no longer required" claim.
2. `scripts/token-dashboard.sh` (969 lines; embeds 319-line Python heredoc lines 31–350 + HTML heredoc closing at line 965). Runs in the Bitbucket master deploy step. Phase 5 §3 incorrectly claimed `dashboard-generator.ts` was its replacement — they are separate dashboards (token consumption vs. rule lifecycle).

Phase 7 ports both, eliminates `python3` from the dashboard-generation hot path, and lands the "Node port complete (Phases 1–7)" marker in `CLAUDE.md`.

---

## Task list (4 tasks)

| ID | Task | Owner files | Deps | Est. | ACs |
|----|------|-------------|------|------|-----|
| **T1** | Port `scripts/setup` (321 lines, **8** `read -p` prompts at lines 62, 228, 233, 236, 246, 249, 259, 299) → `scripts/setup.js`. Interactive prompts via `node:readline`; `--config-file <path>` non-interactive flag (parse YAML via inline `parseSimpleYaml` copy-pasted from `scripts/list-projects.js:53-63`); `--info` flag (print MCP service descriptions per `scripts/setup:307-321`); ANSI gated by `useColor = !process.env.NO_COLOR && process.stdout.isTTY`; reprompt loop on invalid input (per `scripts/setup:233-237`). Add `.cmd` sibling and convert original to 2-line bash stub. | `scripts/setup.{js,cmd}` (new), `scripts/setup` (→ 2-line bash stub), `tests/scripts/setup.test.js` (new, ≥ 4 cases) | — | 3.5h | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7 |
| **T2** | Port `scripts/token-dashboard.sh` (969 lines; Python heredoc 31–350 + HTML heredoc closing at 965) → `scripts/token-dashboard.js`. **Critical-path long pole.** Three-pass architecture: (1) load + group by `session_id`; (2) per-session leg-reset walk with `LEG_RESET_THRESHOLD = 0.05` over `LEG_RESET_FIELDS`; (3) delta attribution over `DELTA_FIELDS` (NOT prompts — AC-12). HTML template moves verbatim from heredoc to JS template literal. `--json-only` mode skips HTML write. Author `tests/fixtures/token-events-sample.jsonl` (8–12 synthetic events covering: simple session, leg-reset, multi-day session crossing UTC midnight, prompts non-reset). Add `.cmd` sibling and convert original to 2-line bash stub. | `scripts/token-dashboard.{js,cmd,sh}` (new + stub-rewrite), `tests/scripts/token-dashboard.test.js` (new, ≥ 5 cases), `tests/fixtures/token-events-sample.jsonl` (new) | — | 6h | AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15, AC-16 |
| **T3** | Cross-cutting wiring: update `package.json:48-49` so `tokens:dashboard` → `node ./scripts/token-dashboard.js` and `tokens:data` → `node ./scripts/token-dashboard.js --json-only`. Update `CLAUDE.md` "Node port complete" line to cite Phases 1–7 and add a Phase 7 row to the phase reference table. Verify both `.js` files parse via `node --check` before claiming the port complete. | `package.json`, `CLAUDE.md` | T1, T2 | 0.5h | AC-17, AC-18 |
| **T4** | Smoke + reviewer: `npm test` (target ≈ 210 tests = ~200 baseline post-Phase-6 + ~10 new from Phase 7); `node --check` on the 2 new `.js` files; reviewer agent reviews against all 19 ACs; AC-19 cross-OS CI gate confirmed (existing matrix triggers on `scripts/**` and `tests/**`); `git status` clean. Live verification: `npm run tokens:dashboard` produces `.claude/visualizations/token-dashboard.html` with no `python3` invocation. | none (read-only/test) | T3 | 1.5h | AC-19, gate for all 19 |

**Critical path**: T2 (6h) → T3 (0.5h) → T4 (1.5h) = **8h**.

T1 and T2 are independent — Wave 1 fans them both out at once.

---

## Wave plan — 3 waves, peak 2-way concurrency

### Wave 1 — 2 parallel implementers

| Teammate | Agent type | Task | Files owned |
|----------|-----------|------|-------------|
| `setup-impl` | implementer | **T1** (3.5h) | `scripts/setup.{js,cmd}`, `scripts/setup` (rewrite to stub), `tests/scripts/setup.test.js` |
| `token-dashboard-impl` | implementer | **T2** (long pole, 6h) | `scripts/token-dashboard.{js,cmd,sh}`, `tests/scripts/token-dashboard.test.js`, `tests/fixtures/token-events-sample.jsonl` |

**Sync gate**: Wait for BOTH commits to land before Wave 2.

### Wave 2 — 1 sequential (depends on T1 + T2)

| Teammate | Agent type | Task |
|----------|-----------|------|
| `cross-cutting-impl` | implementer | **T3** (package.json + CLAUDE.md) |

### Wave 3 — Reviewer + Smoke (parallel)

| Teammate | Agent type | Task |
|----------|-----------|------|
| `phase7-reviewer` | reviewer | All 19 ACs review |
| `phase7-smoke` | tester | **T4** (npm test + node --check + AC mapping + live `tokens:dashboard` verify) |

---

## Wall-clock estimate

| Time | Event |
|------|-------|
| t=0 | Wave 1 starts: T1 ∥ T2 |
| t=3.5h | T1 done |
| t=6h | T2 done → Wave 2 (T3) |
| t=6.5h | T3 done → Wave 3 |
| t=8h | T4 + reviewer done; ready for `/pre-push` |
| **Total** | **~8 h elapsed** vs ~11.5 h serial |

---

## Verification

### Local
1. `npm test` — target ≈ 210 tests. All green.
2. `node --check scripts/setup.js && node --check scripts/token-dashboard.js`.
3. **AC-1**: `node scripts/setup.js` from a tempdir produces `.ai-config/settings.yaml` after scripted stdin.
4. **AC-3**: `node scripts/setup.js --config-file <fixture>.yaml` skips all prompts and writes settings.
5. **AC-11**: bash + Node side-by-side run on `tests/fixtures/token-events-sample.jsonl` — totals agree to within 1 cent / 1 token / 1 prompt.
6. **AC-15**: live `npm run tokens:dashboard` invocation does NOT spawn any `python3` process.

### CI (AC-19)
- `cross-os-smoke.yml` matrix gates merge on `ubuntu-latest`, `macos-latest`, `windows-latest`. Phase 5 already broadened `paths` to `scripts/**` and `tests/**` — no CI changes needed in Phase 7.

---

## Reused utilities

| Utility | Source | Used by |
|---------|--------|---------|
| `parseSimpleYaml` | `scripts/list-projects.js:53-63` (copy-paste, top-level keys only) | T1 (`--config-file` mode) |
| `node:readline` | stdlib | T1 (interactive prompts) |
| `node:fs` | stdlib | T1, T2 |
| Inline ANSI constants | new | T1, T2 (gated by `useColor`) |
| Phase 6 bash stub pattern | e.g. `scripts/setup-merge-drivers.sh` | T1, T2 |
| Phase 3 `.cmd` stub pattern | `scripts/fresh-context.cmd` | T1, T2 |

**Note**: `scripts/fresh-context.sh` does NOT exist — only `.cmd`. Bash stub pattern follows Phase 6 (literal filename, not `$(basename "$0")`).

---

## Constraints — non-negotiable

1. CommonJS only: `'use strict';`, `module.exports`, `require()`. No ESM.
2. `node:` prefix on all stdlib imports.
3. No new dependencies — copy `parseSimpleYaml` inline. No `js-yaml`. No `chalk`.
4. **No `python3` invocation anywhere in `token-dashboard.js`.** The `python3 pip` install in `bitbucket-pipelines.yml:25` stays for `awscli` setup; that's not the dashboard step.
5. `LEG_RESET_THRESHOLD = 0.05` preserved exactly.
6. `DELTA_FIELDS` excludes `prompts` — prompts attribute via session aggregate (last event's value), NOT per-event delta (AC-12).
7. HTML template moves verbatim from bash heredoc into a JS template literal.
8. Bash stubs: 2-line `exec node` delegator with literal filename.
9. `.cmd` siblings: `@echo off\nnode "%~dp0<name>.js" %*`.
10. Commit footers cite ACs: `Closes AC-X, AC-Y`.
11. **8 prompts, not 7** — spec said 7; source has 8. Port all 8.
12. `useColor` gating: `!process.env.NO_COLOR && process.stdout.isTTY` (AC-5).

---

## Risks (carried from spec §8)

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | JS `Math.max` semantics differ from Python `max(a, b)` for `None`/`undefined` | Coerce with `(ev[f] || 0)` before max |
| R-2 | `localeCompare` of ISO 8601 timestamps could differ from Python string sort | Use `<` directly; ISO 8601 is sortable as plain string |
| R-3 | HTML template literal escaping (backticks inside template) | Verify with snapshot of rendered HTML start/end |
| R-4 | `--info` mode behavior is undocumented in the script header | Read source carefully; preserve as-is |
| R-5 | `JSON.parse` of a 100k-line `.jsonl` loaded fully in memory | <1 MB at typical sizes; in-memory split is fine |
| R-6 | Bitbucket pipeline `npm run tokens:dashboard` silently runs old bash stub if package.json not updated | T3 explicit AC-17; T4 smoke verifies `node` invocation |
| R-7 | `--config-file` validation differs from interactive prompts; CI scripts could write invalid YAML | Validate required fields; exit 1 + stderr on missing fields |

---

## Out of scope (spec §3)

- Changing the dashboard's visual design or chart layout.
- Merging `token-dashboard.js` into `dashboard-generator.ts`.
- Changing the leg-reset threshold (5%) or the delta-attribution algorithm.
- Removing `python3 pip` install from `bitbucket-pipelines.yml:25` (still needed by `awscli`).
- Changing `.ai-config/settings.yaml` schema or the prompt order.
- Adding new prompts to `setup`. Strict 1:1 UX port plus `--config-file`.
- Adding a `--non-interactive` flag distinct from `--config-file`.
- Replacing inline `parseSimpleYaml` with a `js-yaml` dependency.
- Changing `.github/workflows/cross-os-smoke.yml` paths.

---

## Execute

```bash
/swarm-implement docs/plans/plan-2026-05-06-node-port-phase-7-setup-token-dashboard.md
```
