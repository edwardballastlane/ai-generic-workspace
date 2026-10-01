# Implementation Plan: AI Ticket Estimation — Human SP + AI Estimate Tracking

**Date:** 2026-07-02
**Spec:** [docs/specs/spec-2026-07-02-ai-ticket-estimation.md](../specs/spec-2026-07-02-ai-ticket-estimation.md)
**Project:** `ai-generic-workspace`
**Branch (planned):** `feat/ai-ticket-estimation` — confirm exact branch + base with the user before any commit (CLAUDE.md rule 7)
**Machine-readable:** [plan-2026-07-02-ai-ticket-estimation.json](plan-2026-07-02-ai-ticket-estimation.json)

14 tasks · 4 waves · max parallelism 5 · all 31 ACs mapped.

## Task Table

| ID | Title | Files OWNED (write) | Reads | Deps | ACs | Cx | Agent |
|---|---|---|---|---|---|---|---|
| T-1 | `_lib/ai-estimates.js` cache module (`aiEstimatesPath`/`loadAiEstimates`/`saveAiEstimates`, mkdir+atomicWrite, try/catch load) | `scripts/_lib/ai-estimates.js` | `_lib/jira-story-points.js`, `_lib/process.js` | — | AC-1, AC-3 | S | backend-dev |
| T-2 | `set-ai-estimate.js` CLI: validate ticket/ai-sp/basis, resolve estimator, upsert cache, resolve SID (env → `current.yaml` via `parseSimpleYaml`), best-effort stamp JSON sidecar | `scripts/set-ai-estimate.js` | `_lib/ai-estimates.js`, `_lib/process.js`, `hooks/inject-context-impl.js`, `update-session`, `create-jira-issue.js`, `story-point.md` | T-1 | AC-1, AC-2, AC-4..AC-10 | L | backend-dev |
| T-3 | `.sh`/`.cmd` delegating stubs for `set-ai-estimate` | `scripts/set-ai-estimate.sh`, `scripts/set-ai-estimate.cmd` | `backfill-task-from-transcripts.{sh,cmd}` | — | (file-map; supports AC-31) | S | backend-dev |
| T-4 | Stamp `ai_estimated` in `session-stop.js` `buildEvent` (both branches) + add `AI_ESTIMATES` to `autoCommit` staging | `scripts/hooks/session-stop.js` | — | — | AC-11..AC-14 | M | backend-dev |
| T-5 | Extend `session-stop.test.js`: `ai_estimated:3` sidecar, missing-key, no-sidecar, autoCommit staging present/absent | `tests/hooks/session-stop.test.js` | `hooks/session-stop.js` | T-4 | AC-11..AC-14 (verify) | M | test-writer |
| T-6 | New `set-ai-estimate.test.js` (≥8 cases via `spawnSync`): upsert/overwrite/corrupt, 3 validation rejects, both SID paths, no-sidecar skip, estimator precedence | `tests/scripts/set-ai-estimate.test.js` | `set-ai-estimate.js`, `_lib/ai-estimates.js`, existing test suites (pattern) | T-2 | AC-1..AC-10 (verify) | L | test-writer |
| T-7 | `token-dashboard.js` AI surfaces: `loadAiEstimates` loader, "AI Est" column, accuracy tile (MAE/hit-rate/`n`, `AI_ACCURACY_MIN_SAMPLE`≥5 gate), "AI-SP / 1M tokens" column via parallel `aiSpByTicket` through `ticketCreditUser`, header tooltips | `scripts/token-dashboard.js` | `_lib/ai-estimates.js` | T-1 | AC-23..AC-28 | L | backend-dev |
| T-8 | Extend `token-dashboard.test.js`: AI Est render, accuracy tile over mixed fixture + below-threshold case, AI-SP/1M crediting | `tests/scripts/token-dashboard.test.js` | `token-dashboard.js`, `fixtures/token-events-sample.jsonl` | T-7 | AC-23..AC-28 (verify) | L | test-writer |
| T-9 | `create-jira-issue.js` `--story-points`/`--sp` flag → `fields.customfield_10038`; omitted when absent | `scripts/create-jira-issue.js` | — | — | AC-21, AC-22 | S | backend-dev |
| T-10 | Rewrite `work-ticket.md` create-flow (silent AI estimate → unanchored user prompt → create with user SP → `set-ai-estimate --basis create`) + Story Point Gate (drop AI auto-write, always `set-ai-estimate --basis post-plan`, conditional human-SP prompt if unset) | `.claude/commands/work-ticket.md` | `set-ai-estimate.js`, `create-jira-issue.js`, `_story-point-calibration.md`, `story-point.md` | T-2, T-9 | AC-15..AC-20 | M | doc-writer |
| T-11 | `CLAUDE.md`: session-events / token-dashboard bullets mention `ai_estimated` field + `.ai-memory/ai-estimates.json` cache | `CLAUDE.md` | `session-stop.js`, `_lib/ai-estimates.js`, `set-ai-estimate.js` | T-2, T-4 | AC-30 | S | doc-writer |
| T-12 | `docs/reference/scripts.md`: add `set-ai-estimate.js` usage + cache-file entry under Token Consumption Tracking | `docs/reference/scripts.md` | `set-ai-estimate.{js,sh,cmd}` | T-2, T-3 | AC-31 | S | doc-writer |
| T-14 | New `create-jira-issue.test.js`: assert `customfield_10038` set with `--story-points`, omitted without | `tests/scripts/create-jira-issue.test.js` | `create-jira-issue.js` | T-9 | AC-21, AC-22 (regression) | M | test-writer |
| T-13 | Final review: `npm test` (AC-29), spot-check `work-ticket.md` rendered instructions (AC-15..20), confirm no cross-file regressions | — | all above | T-1..T-12, T-14 | AC-29 (+ AC-15..20 gate) | M | code-reviewer |

## Wave Plan

```
Wave 1 (parallel, no deps)   T-1, T-3, T-4, T-9
Wave 2 (parallel, ← W1)      T-2, T-5, T-7, T-14
Wave 3 (parallel, ← W1,2)    T-6, T-8, T-10, T-11, T-12
Wave 4 (sequential, ← all)   T-13
```

File-ownership verified: no two tasks in a wave write the same file.

## Agent Team (5 teammates)

| Role | Tasks |
|---|---|
| backend-dev-1 | T-1 → T-2 (lib → CLI chain) |
| backend-dev-2 | T-3, T-4, T-9 → T-7 |
| test-writer | T-5 → T-6, T-8, T-14 |
| doc-writer | T-10, T-11, T-12 |
| code-reviewer | T-13 |

Under `/swarm-implement` each task also gets its own per-task consensus-verification panel; T-13 is the additional full-suite integration pass, not a substitute for those.

## Notes / Decisions

- **T-14 added** beyond the spec's §6 test list to give AC-21/22 standing regression coverage (spec left it to manual verification).
- **AC-15..20** (prompt-doc edits) are not `npm test`-verifiable by nature — verified by T-13 reading rendered `work-ticket.md`.
- Sidecar write target is the **JSON** `by-id/<sid>.json` (not `.yaml`) — see spec §5.3 / R-1.
- `AI_ACCURACY_MIN_SAMPLE` default 5, env-overridable — spec §5.8 / R-2.

## Execute

```
/swarm-implement docs/plans/plan-2026-07-02-ai-ticket-estimation.md
```
