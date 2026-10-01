# Specification: AI Ticket Estimation — Human SP + AI Estimate Tracking

**Author**: Spec Writer
**Date**: 2026-07-02
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch (planned)**: `feat/ai-ticket-estimation` — confirm exact branch name + base branch with the user before creating commits (per `CLAUDE.md` rule 7)
**Jira**: n/a

## 1. Problem Statement

`/work-ticket`'s create flow (`.claude/commands/work-ticket.md:144-161`) never asks the user to story-point a ticket before it is created — story points are simply absent until the post-planning gate. That gate (`work-ticket.md:538-566`, step 4) then has the **AI auto-write** the human-owned field `customfield_10038` via `editJiraIssue`, using its own sizing as if it were the human's estimate.

Net effect: there is no human-owned estimate captured at create time, and the AI's own estimate is never recorded anywhere — it is discarded the moment it gets written into the human field. Without an independently preserved AI estimate, we cannot measure AI sizing accuracy (AI vs. human) or AI-estimated throughput, and the token dashboard's existing "SP / 1M tokens" column (`scripts/token-dashboard.js:741`) has no AI-side counterpart.

**Who is affected**: the team using `/work-ticket` to create and plan tickets (all engineers), and whoever reads the token dashboard for team/individual throughput reporting.

**Impact of not solving**: AI sizing quality is unmeasurable, human SP data is polluted by the AI silently overwriting `customfield_10038`, and there's no way to answer "is the AI a good estimator?" or "how much AI-estimated work ships per token spent?"

## 2. Goals

1. On `/work-ticket` create, the **user** sets authoritative story points on `customfield_10038` before the ticket is created; the AI computes and records its **own, independent** estimate separately, without ever influencing or being shown to the user first.
2. Persist the AI estimate in a local, git-tracked, Jira-free cache (`.ai-memory/ai-estimates.json`) joined to human SP by ticket key — dashboard reads it directly, never calls Jira.
3. Stamp `ai_estimated` into every `session_end` event in `.ai-memory/session-end-events.jsonl`.
4. Add three dashboard surfaces, all fed by joining `jira-story-points.json` (human SP) and `ai-estimates.json` (AI SP) on ticket key: an "AI Est" column, an AI-sizing accuracy tile (MAE + hit rate), and an "AI-SP / 1M tokens" throughput column.

## 3. Non-Goals

- No new Jira custom field. `customfield_10038` remains the only Jira-side story-point field.
- AI estimates **never** write to Jira, at create time or post-plan.
- No change to human SP storage or lifecycle: `customfield_10038` → `.ai-memory/jira-story-points.json` via `scripts/_lib/jira-story-points.js` is untouched.
- No historical backfill of AI estimates for already-created tickets.
- No per-session AI-SP double counting — credit once per ticket, exactly like the existing human-SP crediting logic (`ticketCreditUser`, `token-dashboard.js:902-916`).
- No new `.gitattributes` merge driver for `ai-estimates.json` — it mirrors `jira-story-points.json`, which also has no `merge=union` entry (confirmed in `.gitattributes:1-13`); plain last-write-wins git merge is acceptable at this cache's write frequency (once per ticket).
- Per-user accuracy column in the "By User" table is opportunistic only ("if the join is cheap"), not a blocking acceptance criterion — see §5.8 and Non-Goal note in AC-25.

## 4. Acceptance Criteria

### `.ai-memory/ai-estimates.json` + `scripts/_lib/ai-estimates.js` (3 ACs)

- [ ] **AC-1** — Given no existing cache file, when `set-ai-estimate.js` upserts a ticket, then `.ai-memory/ai-estimates.json` is created (parent dir made if missing) with shape `{ "entries": { "<TICKET>": { "ai_sp": N, "basis": "create"|"post-plan", "estimator": "<model-id>", "estimated_at": "<ISO ts>" } } }`.
- [ ] **AC-2** — Given an existing entry for `PROJ-1234` with `basis: "create"`, when `set-ai-estimate.js --ticket PROJ-1234 --ai-sp 5 --basis post-plan` runs, then `entries.PROJ-1234` is fully replaced (`ai_sp: 5, basis: "post-plan"`, fresh `estimated_at`) — not appended as a second record.
- [ ] **AC-3** — Given a missing or corrupt cache file, `loadAiEstimates(rootDir)` returns `{ entries: {} }` without throwing (mirrors `loadSpCache`'s try/catch, `scripts/_lib/jira-story-points.js:28-37`).

### `scripts/set-ai-estimate.js` (7 ACs)

- [ ] **AC-4** — Given `--ticket notaticket --ai-sp 3 --basis create`, exits non-zero, prints a validation error to stderr, and does **not** write to `ai-estimates.json`.
- [ ] **AC-5** — Given `--ticket PROJ-1 --ai-sp 4 --basis create` (4 is not on the `0.5,1,2,3,5,8,13` scale), exits non-zero with a validation error; no cache write.
- [ ] **AC-6** — Given `--ticket PROJ-1 --ai-sp 3` with `--basis` missing or set to a value other than `create`/`post-plan`, exits non-zero.
- [ ] **AC-7** — Given `CLAUDE_SESSION_ID=<sid>` in the environment and `.ai-session/by-id/<sid>.json` exists, a valid call stamps `ai_estimated: <ai_sp>` onto that sidecar JSON via `atomicWrite`, leaving all other sidecar fields untouched.
- [ ] **AC-8** — Given no `CLAUDE_SESSION_ID` env var but `.ai-session/current.yaml` contains `claude_session_id: "<sid>"` and `.ai-session/by-id/<sid>.json` exists, a valid call resolves `<sid>` from `current.yaml` and stamps that sidecar the same way.
- [ ] **AC-9** — Given neither an env var nor a resolvable sidecar `.json` file, a valid call still exits 0, still writes `ai-estimates.json`, and prints nothing about the missing sidecar (silent skip).
- [ ] **AC-10** — Given no `--estimator` flag: with `CLAUDE_MODEL=claude-opus-4-8` set, the cache entry's `estimator` is `"claude-opus-4-8"`; with neither `--estimator` nor `CLAUDE_MODEL` set, `estimator` is `"unknown"`.

### `scripts/hooks/session-stop.js` (4 ACs)

- [ ] **AC-11** — Given a sidecar with `ai_estimated: 3`, the emitted `session_end` event has `ai_estimated: 3` (sidecar branch, `buildEvent`).
- [ ] **AC-12** — Given a sidecar without an `ai_estimated` key, the emitted event has `ai_estimated: null` (sidecar branch, nullish-coalescing default).
- [ ] **AC-13** — Given no sidecar is resolvable (no-sidecar fallback branch), the emitted event has `ai_estimated: null`.
- [ ] **AC-14** — Given `.ai-memory/ai-estimates.json` exists on disk in a git repo, `autoCommit` stages it alongside `jira-story-points.json` and includes it in the commit pathspec; given it does not exist, the commit still succeeds without it (existing "stage only what exists" behavior preserved).

### `.claude/commands/work-ticket.md` — create flow (3 ACs)

- [ ] **AC-15** — The create-ticket flow documents the AI computing its own estimate (reading `.claude/commands/_story-point-calibration.md`) **before** prompting the user, and holding it silently — with an explicit instruction to never reveal the AI's number to the user.
- [ ] **AC-16** — The create-ticket flow documents prompting the user for story points with no anchoring (no AI number shown), then creating the ticket (MCP `createJiraIssue` first, REST `create-jira-issue.js` fallback) with the user's value on `customfield_10038`, followed by the existing sprint-assignment step.
- [ ] **AC-17** — The create-ticket flow documents running `node scripts/set-ai-estimate.js --ticket <KEY> --ai-sp <N> --basis create` immediately after ticket creation, before continuing to Project Discovery.

### `.claude/commands/work-ticket.md` — Story Point Gate (3 ACs)

- [ ] **AC-18** — The gate no longer instructs `editJiraIssue` to set `customfield_10038` from the AI's own estimate.
- [ ] **AC-19** — The gate documents always recording the AI's estimate via `node scripts/set-ai-estimate.js --ticket <KEY> --ai-sp <N> --basis post-plan`, regardless of whether human SP is already set.
- [ ] **AC-20** — The gate documents: if human SP (`customfield_10038`) is missing, prompt the user and set it via `editJiraIssue` to their value; if it is already set, leave it and do not prompt.

### `scripts/create-jira-issue.js` — REST-fallback parity (2 ACs)

- [ ] **AC-21** — Given `--story-points 3`, the POST body's `fields.customfield_10038` is `3`.
- [ ] **AC-22** — Given no `--story-points` flag, the field is omitted from the create payload (unchanged default behavior).

### `scripts/token-dashboard.js` (6 ACs)

- [ ] **AC-23** — `loadAiEstimates(rootDir)` returns `{ byTicket: {...entries}, available: true }` when `.ai-memory/ai-estimates.json` exists, and `{ byTicket: {}, available: false }` when it does not (mirrors `readSpFromCache`, `scripts/token-dashboard.js:590-597`).
- [ ] **AC-24** — The "By Jira Ticket" table renders an "AI Est" column immediately after the "SP" column, showing `ai_sp` when present and `—` otherwise.
- [ ] **AC-25** — Given a fixture with ≥1 ticket carrying both human SP > 0 and AI SP > 0, the accuracy tile shows MAE (`mean(|ai_sp − human_sp|)`), Hit Rate (fraction within one scale-step on `0.5,1,2,3,5,8,13`), and sample count `n`, computed only over the comparable subset.
- [ ] **AC-26** — Given fewer than the configured minimum comparable-ticket count (`AI_ACCURACY_MIN_SAMPLE`, default 5), the tile renders "insufficient data" instead of computed numbers.
- [ ] **AC-27** — The "By User" table gets an "AI-SP / 1M tokens" column adjacent to the existing "SP / 1M tokens" column, computed as `(aiSpCredited × 1,000,000) ÷ tokens`, using the same `ticketCreditUser` map the SP column already uses (`token-dashboard.js:902-916`) applied to a parallel `aiSpByTicket`.
- [ ] **AC-28** — The new headers ("AI Est", accuracy tile, "AI-SP / 1M tokens") each carry a `title` tooltip, matching the existing `<th title="...">` pattern (e.g. `token-dashboard.js:741,771`).

### Cross-cutting / Docs (3 ACs)

- [ ] **AC-29** — `npm test` exits 0, including new tests in `tests/scripts/set-ai-estimate.test.js`, the extended `tests/hooks/session-stop.test.js`, and the extended `tests/scripts/token-dashboard.test.js`.
- [ ] **AC-30** — `CLAUDE.md`'s session-events / token-dashboard bullets mention the `ai_estimated` field and the `.ai-memory/ai-estimates.json` cache.
- [ ] **AC-31** — `docs/reference/scripts.md` documents `scripts/set-ai-estimate.js` (usage + the cache file it writes) under the "Token Consumption Tracking" section.

**Total: 31 ACs.**

## 5. Technical Design

### 5.1 Architecture / data flow

```
/work-ticket create              Story Point Gate (post-plan)
  AI: silent estimate               AI: silent estimate
  user: sets SP → customfield_10038 human SP already set? skip prompt : prompt+set
  create ticket (user's SP)         │
  │                                 │
  └──► set-ai-estimate.js ◄─────────┘   (--basis create | post-plan)
              │
              ├─► upsert .ai-memory/ai-estimates.json   (git-tracked, Jira-free)
              └─► stamp ai_estimated on .ai-session/by-id/<sid>.json (best-effort)
                        │
                        ▼
              scripts/hooks/session-stop.js (Stop hook)
                        │  buildEvent() copies sidecar.ai_estimated → event.ai_estimated
                        ▼
              .ai-memory/session-end-events.jsonl (session_end events)
                        │
                        ▼
              scripts/token-dashboard.js
                joins jira-story-points.json (human SP) + ai-estimates.json (AI SP) by ticket key
                → "AI Est" column, accuracy tile, "AI-SP / 1M tokens" column
```

The dashboard never calls Jira for either cache — same posture as `readSpFromCache()` (`token-dashboard.js:583-589` comment block).

### 5.2 Data model — `.ai-memory/ai-estimates.json`

```json
{
  "entries": {
    "PROJ-1234": {
      "ai_sp": 3,
      "basis": "create",
      "estimator": "claude-opus-4-8",
      "estimated_at": "2026-07-02T18:00:00.000Z"
    }
  }
}
```

- `ai_sp` — same scale as human SP: `0.5, 1, 2, 3, 5, 8, 13`.
- `basis` — `"create"` (ticket-creation time) or `"post-plan"` (post-planning gate, e.g. for a brought-in ticket without a create-time estimate).
- `estimator` — model id string; `estimated_at` — ISO timestamp.
- Upsert semantics: the entry is **replaced** on every write for that ticket key (last write wins) — no history array. A later `post-plan` call overwrites an earlier `create` call for the same ticket.
- Human SP stays authoritative and untouched in `customfield_10038` / `.ai-memory/jira-story-points.json` — this cache never reads or writes that file.

New module `scripts/_lib/ai-estimates.js` mirrors `scripts/_lib/jira-story-points.js:24-43` (`spCachePath`/`loadSpCache`/`saveSpCache`):

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function aiEstimatesPath(rootDir) {
  return path.join(rootDir, '.ai-memory', 'ai-estimates.json');
}
function loadAiEstimates(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(aiEstimatesPath(rootDir), 'utf8'));
    return { entries: raw.entries || {} };
  } catch { return { entries: {} }; }
}
function saveAiEstimates(rootDir, cache) { /* mkdir + atomicWrite, mirrors saveSpCache */ }

module.exports = { aiEstimatesPath, loadAiEstimates, saveAiEstimates };
```

This module is imported by both the writer (`set-ai-estimate.js`) and the reader (`token-dashboard.js`'s `loadAiEstimates(rootDir)`), exactly the way `token-dashboard.js:16` already imports `{ loadSpCache, spCachePath }` from `_lib/jira-story-points.js` rather than reimplementing cache I/O.

### 5.3 New script — `scripts/set-ai-estimate.js`

```
node scripts/set-ai-estimate.js --ticket PROJ-1234 --ai-sp 3 --basis create [--estimator <id>]
```

CommonJS, `'use strict'`, `node:` builtins, boundary validation only (per `CLAUDE.md` code conventions). Arg parsing supports both `--flag value` and `--flag=value`, matching `scripts/create-jira-issue.js:48-68`.

1. Validate `--ticket` against `/^[A-Z]+-\d+$/` and `--ai-sp` against the allowed scale `[0.5,1,2,3,5,8,13]`; validate `--basis` ∈ `{create, post-plan}`. Reject with a stderr message + non-zero exit on any failure (AC-4..6).
2. `estimator` = `--estimator` if given, else `process.env.CLAUDE_MODEL`, else `'unknown'` (AC-10).
3. `estimated_at = new Date().toISOString()`.
4. `entries[ticket] = { ai_sp, basis, estimator, estimated_at }`, `saveAiEstimates(ROOT_DIR, cache)` via `atomicWrite` (`scripts/_lib/process.js:14-18`).
5. Resolve the active session id exactly like `update-session` (`scripts/update-session:31-50`): `SID = process.env.CLAUDE_SESSION_ID`; if unset, read `.ai-session/current.yaml` and extract `claude_session_id`. **Write target** (see Risks §8, R-1): the file stamped is the **JSON sidecar** `.ai-session/by-id/<SID>.json` — the same object `session-stop.js`'s `buildEvent` reads as `sidecar` (`scripts/hooks/session-stop.js:299-306`) — not the YAML task-binding file `by-id/<SID>.yaml` that `update-session` edits. Reuse the exported `parseSimpleYaml` from `scripts/hooks/inject-context-impl.js:79-120,624` to read `current.yaml`'s `claude_session_id` field instead of re-deriving a regex.
6. If `SID` is empty or `.ai-session/by-id/<SID>.json` doesn't exist, skip the sidecar write silently — the cache write in step 4 has already succeeded (AC-9).
7. Companion stubs: `scripts/set-ai-estimate.sh` (2-line bash delegator) and `scripts/set-ai-estimate.cmd` (Windows), matching the pattern at `scripts/backfill-task-from-transcripts.sh`/`.cmd`:

```sh
#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/set-ai-estimate.js" "$@"
```
```bat
@echo off
node "%~dp0set-ai-estimate.js" %*
```

### 5.4 `scripts/hooks/session-stop.js` changes

`buildEvent` (`scripts/hooks/session-stop.js:92-154`):
- Sidecar branch (event object at lines 96-118): add `ai_estimated: sidecar.ai_estimated ?? null` alongside the existing `lines_removed` field.
- No-sidecar fallback (event object at lines 135-153): add `ai_estimated: null`.

`autoCommit` (`scripts/hooks/session-stop.js:165-211`): the passive-staging loop at lines 185-192 already iterates `[SP_CACHE, VALUE_EVENTS]` and stages only files that exist. Add a third constant `AI_ESTIMATES = '.ai-memory/ai-estimates.json'` to that list — no other change needed, the existence-check + pathspec logic already generalizes.

### 5.5 `.claude/commands/work-ticket.md` — create flow

Replace the "create" sub-flow at `work-ticket.md:144-161` with explicit ordering that keeps the AI estimate independent of the human one:

1. Draft & show the ticket (existing step, unchanged).
2. **AI computes its own estimate first**, silently: read `.claude/commands/_story-point-calibration.md` and size the ticket per `/story-point`'s method — hold the number, never display it.
3. Prompt the user for story points with **no anchoring** (never show the AI's number, never hint at a range).
4. Create via `createJiraIssue` (MCP first; REST fallback `scripts/create-jira-issue.js`) with the **user's** value on `customfield_10038`, then the existing sprint-assignment step (`work-ticket.md:147`).
5. Immediately after creation: `node scripts/set-ai-estimate.js --ticket <KEY> --ai-sp <N> --basis create`.
6. Continue to Project Discovery (existing `work-ticket.md:156-161` block, unchanged).

### 5.6 `.claude/commands/work-ticket.md` — Story Point Gate

Replace step 4 of the gate at `work-ticket.md:557-564` (currently "Use `editJiraIssue` to set `customfield_10038`..."):

1. Compute the AI's own estimate from the architect's output + calibration file (unchanged step 2-3).
2. **Always** run `node scripts/set-ai-estimate.js --ticket <KEY> --ai-sp <N> --basis post-plan` — this never touches Jira.
3. Check whether human SP is already set (`customfield_10038` via `getJiraIssue`, or the cached `.ai-memory/jira-story-points.json` entry). If **missing**, prompt the user for their estimate and `editJiraIssue` to set `customfield_10038` to their value. If **already set**, leave it — no prompt.
4. Report both numbers are recorded (not "story points set: N" as before — that phrasing implied Jira was written from the AI number).

### 5.7 `scripts/create-jira-issue.js` — REST-fallback parity

The create flow's step 4 (§5.5) requires the REST fallback to be able to set `customfield_10038` at creation, which it currently cannot (`fields` object built at `scripts/create-jira-issue.js:235-243` has no SP field). Add a `--story-points <N>` flag (`--sp` alias optional) that, when present, sets `fields['customfield_10038'] = Number(opts.storyPoints)`; omitted when absent (unchanged default).

### 5.8 `scripts/token-dashboard.js` changes

- New loader `loadAiEstimates(rootDir)` (imported from `scripts/_lib/ai-estimates.js`, §5.2), called alongside the existing `readSpFromCache()` call site at `token-dashboard.js:1531-1532`; result stored as `data.ai_estimates = { byTicket: entries }`.
- **(a) "AI Est" column** — in the ticket-table `<thead>` (`token-dashboard.js:771`) insert a new `<th>` right after the SP `<th>`; in the render loop (`token-dashboard.js:1176-1192`) build a cell from `raw.ai_estimates[tk.ticket]?.ai_sp ?? '—'`, mirroring the existing `spCell` construction at lines 1182-1189.
- **(b) AI-sizing accuracy tile** — new section, computed once over all tickets where `human_sp > 0 && ai_sp > 0`: `MAE = mean(|ai_sp − human_sp|)`, `Hit rate = fraction within one step on [0.5,1,2,3,5,8,13]`. Show sample count `n`; below `AI_ACCURACY_MIN_SAMPLE` (default 5, env-overridable per the pattern at `token-dashboard.js:580-581`), render "insufficient data" (R-2). Per-user breakdown is optional: only add a "By User" column if it reuses the existing `ticketCreditUser` join cheaply; otherwise skip per the decided scope (Non-Goals).
- **(c) "AI-SP / 1M tokens"** — in the user-table `<thead>` (`token-dashboard.js:761`) insert a `<th>` adjacent to a to-be-added-or-existing "SP / 1M tokens" header (currently only on the Adoption table, `token-dashboard.js:741` — extend the same computation to the By-User table using a parallel `aiSpByTicket` map, reusing `ticketCreditUser` from `token-dashboard.js:902-916`); formula `(aiSp × 1,000,000) ÷ tokens`, mirroring `spPerMillionTokens` at line 928.
- All new `<th>` elements get `title=` tooltips, matching the existing convention throughout the table headers (e.g. lines 741, 771).

### 5.9 Dependencies

No new external libraries. Reuses: `scripts/_lib/process.js` (`atomicWrite`), `scripts/_lib/jira-story-points.js` (pattern reference only — no cross-import), `scripts/hooks/inject-context-impl.js` (`parseSimpleYaml`), `node:fs`, `node:path`.

## 6. Test Strategy

- **`tests/scripts/set-ai-estimate.test.js`** (`node:test` + `node:assert`, tempdir fixtures via `os.tmpdir()` + `fs/promises.mkdtemp`, matching `tests/scripts/token-dashboard.test.js:15-17` and `tests/hooks/session-stop.test.js:16-22`):
  - cache upsert for a new ticket (AC-1).
  - `create` → `post-plan` overwrite on the same ticket (AC-2).
  - corrupt/missing cache file tolerance (AC-3).
  - invalid ticket key / off-scale `ai-sp` / invalid `basis` all reject with non-zero exit and no cache write (AC-4, AC-5, AC-6).
  - sidecar stamp via `CLAUDE_SESSION_ID` env (AC-7) and via `current.yaml` fallback (AC-8).
  - no-sidecar-resolvable path: cache write still succeeds, no error surfaced (AC-9).
  - `--estimator` / `CLAUDE_MODEL` precedence (AC-10).
  - Drive the CLI via `spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmpRoot, env, encoding: 'utf8' })`, same pattern as `runHook`/`runDashboard` in the existing test suites.

- **Extend `tests/hooks/session-stop.test.js`**: add a fixture sidecar variant with `ai_estimated: 3` and assert the emitted event's `ai_estimated` field (AC-11); assert `ai_estimated: null` when the sidecar omits the field (AC-12) and in the no-sidecar path (AC-13); assert `ai-estimates.json` is staged by `autoCommit` when present (AC-14), reusing the existing git-tempdir-repo setup already present in that suite.

- **Extend `tests/scripts/token-dashboard.test.js`**: add fixture entries to a copy/extension of `.ai-memory/ai-estimates.json` alongside the existing `tests/fixtures/token-events-sample.jsonl` pattern (`tmpDir`/`setupFixture` helpers at `tests/scripts/token-dashboard.test.js:15-24`):
  - "AI Est" column renders `ai_sp` or `—` (AC-24).
  - accuracy tile computes MAE + hit rate over a mixed fixture with some tickets missing one side of the pair, and a separate case below the insufficient-data threshold (AC-25, AC-26).
  - "AI-SP / 1M tokens" credits correctly through `ticketCreditUser`/`aiSpByTicket` (AC-27).

- All new tests run under the existing `npm test` / CI matrix — no new CI config needed (`cross-os-smoke.yml` already triggers on `scripts/**`, `tests/**`).

## 7. Implementation Notes

- Suggested build order: `scripts/_lib/ai-estimates.js` → `scripts/set-ai-estimate.js` (+ stubs + its tests) → `session-stop.js` diff (+ tests) → `token-dashboard.js` diff (+ tests) → `work-ticket.md` prompt-doc edits → `create-jira-issue.js` `--story-points` flag → docs (`CLAUDE.md`, `docs/reference/scripts.md`).
- `work-ticket.md` and `_story-point-calibration.md` changes are prompt-doc edits, not executable code — their ACs (AC-15..20) are verified by reading the rendered instructions, not by a test runner.
- Reuse `parseSimpleYaml` (exported from `scripts/hooks/inject-context-impl.js:624`) rather than writing a second ad hoc YAML-line-scraper for `current.yaml` — the file already tolerates the `claude_session_id: ""` empty-quoted placeholder `start-session` writes before CC binds (`inject-context-impl.js:79-120`).
- `set-ai-estimate.js`'s ticket/scale validation should reuse the same literals the rest of the codebase hardcodes (`.claude/commands/story-point.md:14` scale, `[A-Z]+-\d+` pattern already used at `work-ticket.md:107`) rather than importing from `_lib/heuristics.js`'s `BROAD_JIRA_RE`, which is intentionally scoped differently (see `docs/specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md` Non-Goals on not widening `extractJiraTicket`).
- `autoCommit`'s pathspec-skip-if-absent behavior (`session-stop.js:171-181`) already generalizes to a third file — no new logic needed there, just add the constant to the staging list.

## 8. Risks & Open Questions

| ID | Risk / Question | Notes / Recommendation |
|---|---|---|
| R-1 | **Sidecar file target.** The original design wording said "resolve ... exactly like `update-session` (`$CLAUDE_SESSION_ID` → `.ai-session/by-id/<id>.yaml`, fallback `current.yaml`)" — but `session-stop.js`'s `buildEvent` reads `sidecar.ai_estimated` from the **JSON** file at `by-id/<sid>.json` (`session-stop.js:299-306`), a different file than the `.yaml` task-binding file `update-session` edits. | **Resolved** (§5.3/step 5): reuse `update-session`'s **SID-resolution algorithm** (env → `current.yaml`), but **write to the `.json` sidecar**, not the `.yaml` file — required for the passthrough to work. |
| R-2 | Insufficient-data threshold for the accuracy tile. | **Resolved**: default `n < 5`, env-overridable `AI_ACCURACY_MIN_SAMPLE`, consistent with the existing env-overridable-threshold pattern (`ADOPTION_MIN_PROMPTS_PER_DAY`, `token-dashboard.js:580-581`). |
| R-3 | **Anchoring discipline** in the create flow depends entirely on prompt ordering in `work-ticket.md` — there's no code-level enforcement that the AI can't leak its number before the user answers. | Accepted risk per decided design; mitigate with an explicit "never reveal" instruction (AC-15) and periodic spot-checks of transcripts. |
| R-4 | Sparse comparison set early on — few tickets will have both a human and an AI estimate at first. | Accuracy tile must show `n` and degrade gracefully (AC-25/26); do not silently hide the tile. |
| R-5 | REST-fallback parity gap: `scripts/create-jira-issue.js` currently has no way to set `customfield_10038` at all — needed for §5.5 step 4 when the MCP path is unavailable. | Addressed in §5.7 / AC-21/22; flagged because it wasn't in the original file list but is required for the create flow to actually work end-to-end via the fallback path. |
| R-6 | Two parallel terminals racing on `set-ai-estimate.js`'s sidecar stamp. | Low risk — same class of race the per-cc-session-binding work already solved for `current.yaml`/`by-id/*` (`docs/specs/spec-2026-05-15-per-cc-session-binding.md`); each terminal's own `by-id/<sid>.json` is independent, so no cross-session clobbering. |

## 9. File Map

**New files:**

| File | Description |
|---|---|
| `scripts/_lib/ai-estimates.js` | `aiEstimatesPath`/`loadAiEstimates`/`saveAiEstimates`, mirrors `_lib/jira-story-points.js` cache I/O |
| `scripts/set-ai-estimate.js` | CLI: upsert `ai-estimates.json` + best-effort sidecar stamp |
| `scripts/set-ai-estimate.sh` | 2-line bash stub delegating to `.js` |
| `scripts/set-ai-estimate.cmd` | Windows cmd stub |
| `tests/scripts/set-ai-estimate.test.js` | ≥ 8 cases per §6 |

**Modified files:**

| File | Change |
|---|---|
| `scripts/hooks/session-stop.js` | `buildEvent`: `ai_estimated` in both branches (lines ~96-118, ~135-153); `autoCommit`: stage `.ai-memory/ai-estimates.json` alongside `SP_CACHE` (~line 168, 185-192) |
| `scripts/token-dashboard.js` | `loadAiEstimates` call (~line 1531-1532); "AI Est" column (ticket table, ~lines 771, 1176-1192); accuracy tile (new section); "AI-SP / 1M tokens" column (user table, ~lines 761, 902-928) |
| `scripts/create-jira-issue.js` | `--story-points` flag → `fields.customfield_10038` (~lines 48-68, 235-243) |
| `.claude/commands/work-ticket.md` | Create flow reorder (~lines 144-161); Story Point Gate rewrite (~lines 538-566) |
| `tests/hooks/session-stop.test.js` | + `ai_estimated` passthrough / null-fallback / autoCommit-staging cases |
| `tests/scripts/token-dashboard.test.js` | + AI Est column / accuracy tile / AI-SP-per-1M cases |
| `CLAUDE.md` | Token-dashboard / session-events bullets mention `ai_estimated` field + `.ai-memory/ai-estimates.json` cache |
| `docs/reference/scripts.md` | Add `scripts/set-ai-estimate.js` entry under "Token Consumption Tracking" |

**New data file (git-tracked, created on first write, not committed empty):**

| File | Description |
|---|---|
| `.ai-memory/ai-estimates.json` | AI estimate cache, keyed by ticket, shape per §5.2 |

**Deleted files:** None.

## Grounding Citations

- Create-flow gap: `.claude/commands/work-ticket.md:144-161`
- Story Point Gate auto-write: `.claude/commands/work-ticket.md:538-566` (field write at line 562)
- Story-point scale + field id: `.claude/commands/story-point.md:9-14`
- Calibration anchors file: `.claude/commands/_story-point-calibration.md`
- SP cache shape/lifecycle to mirror: `scripts/_lib/jira-story-points.js:24-43`
- Existing human-SP cache sample: `.ai-memory/jira-story-points.json`
- `atomicWrite`: `scripts/_lib/process.js:14-18`
- `buildEvent` sidecar branch: `scripts/hooks/session-stop.js:92-133`
- `buildEvent` no-sidecar branch: `scripts/hooks/session-stop.js:135-154`
- `autoCommit` staging loop: `scripts/hooks/session-stop.js:165-192`
- Sidecar path resolution in the hook: `scripts/hooks/session-stop.js:299-306`
- `update-session` SID resolution order: `scripts/update-session:31-50`
- `parseSimpleYaml` (flat YAML reader, exported): `scripts/hooks/inject-context-impl.js:79-120,624`
- Per-cc-session binding rationale: `docs/specs/spec-2026-05-15-per-cc-session-binding.md`
- SP column + tooltip pattern: `scripts/token-dashboard.js:741,771`
- `story_points` load into dashboard data: `scripts/token-dashboard.js:1531-1532`
- SP crediting logic (`ticketCreditUser`): `scripts/token-dashboard.js:902-916`
- `spPerMillionTokens` formula: `scripts/token-dashboard.js:928`
- Ticket-table SP cell render: `scripts/token-dashboard.js:1176-1192`
- `readSpFromCache` (loader pattern to mirror): `scripts/token-dashboard.js:583-597`
- REST fallback create payload (no SP field yet): `scripts/create-jira-issue.js:235-252`
- Arg-parsing convention (`--flag value` / `--flag=value`): `scripts/create-jira-issue.js:48-68`
- Bash/cmd stub pattern: `scripts/backfill-task-from-transcripts.sh`, `scripts/backfill-task-from-transcripts.cmd`
- Node-port hook conventions (CommonJS, `node:` builtins, `atomicWrite`, tests in `tests/`): `CLAUDE.md` "Node Port Status" section
- No merge driver on JSON caches: `.gitattributes:1-13`
- Native spec section/format precedent: `docs/specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md`, `docs/specs/spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md`
