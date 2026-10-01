# Upstream Port

How this generic workspace stays caught up with the project workspace it was forked from.

Lane features get built in a project workspace (against real tickets, a real codebase, real
infra). This workspace is the generic distribution. Without a deliberate port step the two
drift apart permanently. `/port-upstream` is that step.

> This is **not** [`./scripts/sync`](sync.md), which mirrors your personal lessons and memory
> between your own machines. This is workspace-to-workspace feature porting.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run drift` | Portable gaps, grouped by area |
| `npm run drift:summary` | Area counts only |
| `npm run drift -- --all` | Include project-specific and local-only files |
| `npm run drift -- --area <prefix>` | Filter to one path prefix |
| `npm run drift -- --json` | Machine-readable, includes per-file term hits |
| `npm run drift -- --upstream <path>` | Compare against a different workspace |
| `npm run drift:scan -- <path...>` | Post-port gate — exit 1 if local files still name the project |

The skill that drives the whole procedure is [`.claude/skills/port-upstream/SKILL.md`](../../.claude/skills/port-upstream/SKILL.md).

## Classification

`scripts/workspace-drift.js` walks the `track` paths on both sides and puts every difference
in a bucket:

- **missing / portable** — upstream-only, no `projectTerms` match. Straight port.
- **missing / project-specific** — upstream-only, names the project. Port the capability only
  if the mechanism is generic, then scrub.
- **drifted / portable** — present both sides; the lines upstream has and this workspace does
  not are clean. Merge them.
- **drifted / project-specific** — those same upstream-only lines name the project. Merge
  selectively.
- **local-only** — added here. Candidate for backporting upstream.

Drift classification uses a trimmed-line set difference, not a real diff — enough to tell
whether upstream's additions drag in project vocabulary, not a substitute for reading the diff.

## Configuration

`.ai-config/upstream.json`:

```json
{
  "upstream": {
    "label": "upstream",
    "path": "/abs/path/to/project-ai-workspace"
  },
  "projectTerms": ["acme", "\\bACME-[0-9]+\\b", "\\bwidget\\b"],
  "track": [".claude/commands", "scripts", "tests", "package.json"],
  "ignore": ["(^|/)node_modules(/|$)", "^scripts/self-improvement/staged-changes/"]
}
```

| Key | Notes |
|-----|-------|
| `upstream.path` | Absolute path. Machine-specific — override per run with `--upstream`. |
| `projectTerms` | JS regexes, matched case-insensitively. Anchor short words with `\b` so a term like `cat` does not match `category`. |
| `track` | Directories (walked recursively) or single files. Anything outside is invisible to the tool. |
| `ignore` | Regexes matched against the relative path. Use for runtime data, build output, and project-only trees. |

Files over 512 KB and non-text extensions are listed as missing but never content-compared.

## Port log

### 2026-09-15 — Cluster 3: ratchets

Ported the four monotonic quality guards, wired them into CI and the verify gate, and
generated baselines against **this** codebase.

**Libraries** (`scripts/_lib/`): `ratchet` (shared baseline parse/serialize/diff),
`deadcode-ratchet`, `guard-population`, `refusal-ratchet`, `retired-terms`.
**CLIs + npm**: `ratchet:{deadcode,guard,refusal,retired,all}`.

**The markers had to come too.** The ratchets guard `pre-tool-use.js`, and the data they
read lives in that file as comments. Ported as-is the guard registry was empty (0 guards)
and 3 refusals were dead-ends — a gate guarding nothing. Added 6 `guard:population` markers
for the guards that actually exist here (upstream has 7; its `session-start` gate is
cluster 5), 1 `refusal:by-design human-authority` on force-push, and upstream's
next-step wording on the two secret refusals. Refusal ratchet now reads 4 actionable /
1 by-design, matching upstream's shape.

**Baselines are NOT portable** — upstream's encode its codebase. Generated fresh here:
0 frozen dead-end refusals, 5 frozen orphans, 6 registered guards. `.retired-terms.txt`
ships **empty on purpose**: upstream's sole entry (`last_message_preview`) is still live
here in `scripts/hooks/subagent-stop.js`, so seeding it would fail the ratchet on
legitimate code.

**CI + gate wiring:** `npm run ratchet:all` added to both `bitbucket-pipelines.yml` steps
(PR and `master`), matching upstream, and to `.lane-verify.json` alongside `npm test`.
Without CI wiring the ratchets guard nothing on a PR — the "config-only wiring" failure
mode from the cluster-1/2 audit.

`ratchet:all` chains only the four ratchets here; upstream's also runs `kb`, `doc-corpus`,
`dashboard-consistency`, `gen-agents-md` and `evals`, which belong to unported clusters.

**Verified beyond unit tests — each ratchet was made to fail and then pass again:**
a new git-tracked orphan tripped deadcode (exit 1), weakening the destructive-rm guard
tripped guard-population with a before/after hash pair, an unmarked `block('Nope.')`
tripped refusal, and a seeded term tripped retired-terms. All four returned to exit 0 on
restore, and `pre-tool-use.js` was confirmed byte-identical to its pre-probe backup.
Note the deadcode ratchet scans the **git index**, not the filesystem — an untracked probe
file is invisible to it, which is deliberate (identical results locally and in CI).

**Pre-emptive CI check:** the baseline was frozen while the ported files were still
untracked, so all 38 were staged with `git add -N` and `ratchet:all` re-run — 145 script
files scanned, still only the 5 pre-existing orphans. Every ported file is genuinely
referenced; the ratchet independently validated the previous two clusters' wiring. The
index was then reset, leaving nothing staged.

**Pre-existing orphans now frozen** (grandfathered, not fixed): `workspace-root.d.ts`,
`self-improvement/backfill-authors.ts`, `session-embedder/check-vectors.js`,
`session-embedder/knowledge-linker.ts`, `session-embedder/tiered-memory.ts`.

**Genericized:** all five modules credited another internal tool by name; removed.
Adding that name to `projectTerms` then surfaced two more hits in already-ported
cluster-1 files — more evidence that a term the list does not know is a term the gate
cannot catch.

Suite: 653 tests, 651 pass, 0 fail.

### 2026-09-15 — Completeness audit of clusters 1 and 2

A post-port sweep (dangling `require()`s, npm targets pointing at missing files,
upstream tests for modules we now have, `settings.json` hook registrations, dead doc
links, references to files that do not exist here). It found five real gaps:

1. **The memory read-path was never ported.** `inject-rules-impl.js` upstream scores
   stored observations against the prompt and surfaces the top 3 with trust framing.
   Without it cluster 1 was write-only: the store filled, `mem_search` worked, but
   nothing ever reached the prompt. Ported (`scoreObservations` + the opt-in block,
   `LANE_INJECT_MEMORY_OBS=1`), with 6 regression tests.
2. **Two upstream tests were missing** for modules we already had:
   `tests/_lib/session-state.test.js` and `tests/hooks/value-logger.test.js`.
3. **`LANE_EVENTS_ROOT` was supported but never set.** The hook reads it; only
   upstream's `.claude/settings.json` set the (project-named) equivalent. Without it a
   session whose cwd is inside `agent/_projects/<project>` logs into that project's
   `.ai-memory` instead of the workspace's. Now set to `$CLAUDE_PROJECT_DIR`.
4. **Three more internal tool names and two dangling doc references**
   survived the first scrub because they were not in `projectTerms`.
5. **`projectTerms` had a blind spot (twice):** `$JIRA_PREFIX-[0-9]{3,}` missed
   short keys, and after widening to any digit count it still missed the BARE prefix —
   so a hardcoded Jira project key in `.claude/commands/work-ticket.md` and 24 doc
   references went through untouched. Fixed by making a term able to carry its own
   flags (`/\bANN\b/g`): the bare prefix has to be matched case-sensitively, because
   case-folded it hits ordinary identifiers like `const ann = ...`.

`projectTerms` gained four more internal tool names and two unported doc paths. Suite after the audit: 614 tests, 612 pass, 0 fail.

**Deliberately not ported:** `scripts/hooks/CLAUDE.md`. `value-logger` finds the
workspace root by walking up for a `CLAUDE.md`, so a nested one under `scripts/hooks/`
stops that walk early — upstream pins around it in `record-verdict.js`. Our hook
conventions already live in the root `CLAUDE.md`, so adding the nested file would
introduce the hazard for no gain. The defensive pin was kept and its comment reworded.

**Two upstream behaviours worth knowing, left as-is:**
- `run()` in `inject-rules-impl.js` returns early when there are no rules, so a
  workspace with an empty `rules.json` never surfaces observations either.
- Rules without `status: 'active'` are skipped by `scoreRules` — easy to trip over
  when writing fixtures.

### 2026-09-15 — Cluster 2: evidence / verification gates

Ported the evidence-based completion gate, verdict discipline, the opt-in verify gate,
and the gate-theater detector.

**Libraries** (`scripts/_lib/`): `evidence`, `verdict`, `verify-gate`, `gate-theater`,
plus `session-state` (the single sidecar I/O owner — cluster 5's centerpiece, pulled
forward because `record-verification` and the hooks both need it).

**CLIs** (`scripts/`): `record-{evidence,verdict,verification}.js`, `verify-evidence.js`,
`verify-gate.js`, `gate-theater-report.js`, behind 5 npm scripts. `.lane-verify.json`
added, pointing at `npm test` rather than upstream's `ratchet:all` (cluster 3, not ported).

**Hooks:** `post-tool-use.js` gained `PR_CREATE_RE`, `verdictFromGate`, `recordPrePrVerdict`
and `recordPrSummary`, and its `files_touched` append now routes through
`sessionState.updateSidecar`; a `require.main` guard was added so the module is requirable
from tests. `session-stop.js` gained `spawnVerifyGate` (detached, advisory,
`VERIFY_GATE_ENABLED=0` to disable). The worktree-pinning half of upstream's
`post-tool-use` drift (`candidateDirs`, `recordActiveWorktree`, `gitRepoAt`,
`isWorkspaceRepo`) belongs to the worktree cluster and was left alone.

**Specs:** `spec-2026-08-03-evidence-based-completion.md`,
`spec-2026-08-03-anti-rubber-stamp-gate.md`.

**Genericized, not copied:** both specs and six source files were framed as borrowings from
another internal tool by name, with cross-links to an ideas doc that is not ported.
The name became *the reference implementation*, the hardening rationale was kept verbatim,
and the dead links were removed. `record-verification`'s usage example moved from
an upstream ticket key / repo name to `PROJ-123` / `api-service`. `recordPrSummary` was updated
for cluster 1's `containsCustomerData` → `containsSensitiveData` rename.

**Verified beyond unit tests:** `record-evidence` captured a real `npm test` run (45 KB
artifact, sha recorded); `verify-evidence` passed it, then correctly failed it after the
artifact was appended to (`sha256 mismatch`) and correctly rejected a hollow green
(`echo "0 tests collected"` asserting `42 tests passed`) — exit 1 in both cases, exit 0 when
valid. `verify-gate` ran for real against `.lane-verify.json` (PASS), skipped on
non-matching paths, and no-opped in a repo without the config. The resulting
`verifier_verdict` event flowed through to `gate-theater-report`. `record-verification`
wrote the evidence log, the value event, and the sidecar's `verify_local` + dedup marker.
7 new post-tool-use regression tests cover the verdict wiring. Suite: 598 tests, 596 pass,
0 fail (2 pre-existing skips).

**Gotcha worth remembering:** these CLIs resolve their root from `WORKSPACE_ROOT`
(defaulting to the script's own workspace), **not** `process.cwd()`. Testing one by `cd`-ing
into a tempdir silently writes to the real workspace — pass `WORKSPACE_ROOT` explicitly.

### 2026-09-15 — Cluster 1: memory store v2

Ported the observation store, its CLIs, the MCP server, and the hook wiring.

**Libraries** (`scripts/_lib/`): `memory-store`, `memory-tiers`, `memory-embed`,
`memory-consolidate`, `memory-migrate`, `memory-board`, `summary-quality`, `toon`,
and `pr-summary` (pulled in for `sessionSummaryId`).

**CLIs** (`scripts/`): `memory-{dashboard,export,mcp-server,migrate,prune-noise,setup,stow}.js`,
wired to 12 `memory:*` npm scripts. `lane-memory` registered in `.mcp.json`.

**Hooks:** `session-start.js` gained change-detected team-memory auto-import;
`session-stop.js` gained the fallback `session_summary` write (noise-gated, idempotent
on a deterministic id) and the auto-export chunk, plus `.ai-memory/observations-export`
in the auto-commit staging list. The rest of those two hooks' upstream drift belongs to
clusters 4 and 5 and was deliberately left alone.

**Genericized, not copied:**

| Upstream | Here |
|----------|------|
| `CUSTOMER_RE` / `STRONG_CUSTOMER_RE` — baked-in `FO\d{3,}` + holdings-table markers | `containsSensitiveData()` reading `sensitivePatterns` / `exemptPatterns` from `.ai-memory/memory-policy.json`; **no policy file means nothing is gated**, because a generic workspace has no domain to protect and invented markers would silently drop real summaries |
| `containsCustomerData` | `containsSensitiveData` (reason code `customer-data` → `sensitive-data`) |
| `KNOWN_PROJECTS` — hardcoded repo slugs | `knownProjects()` reading `agent/_projects/`, longest slug first so `api-service-web` beats `api-service` |
| `TEST_FIXTURE_RE` with a company domain | default exempt list of `demo` / `test account` / `@example.` / `sandbox`, overridable per workspace |
| Comments crediting another internal tool | plain descriptions of the mechanism |

**Gitignore:** `.ai-memory/observations-export/**` and `memory-policy.json` are now tracked
(team-shared); the live per-scope store under `.ai-memory/observations/` stays local.

**Verified beyond unit tests:** `memory:migrate` seeded 118 rules; `memory:stow --dry-run`,
`memory:board`, `memory:export` ran clean; the MCP server round-tripped
`initialize` → `tools/list` → `mem_save` → `mem_search` over stdio; the session-start hook
imported a seeded teammate chunk and no-opped on the second run. 7 new hook regression tests
cover both wirings. Suite: 560 tests, 558 pass, 0 fail (2 pre-existing skips).

**Gotcha worth remembering:** `mem_search` excludes `source: 'rules-shared'` observations by
design (the prompt hook already injects those), and `memory:migrate` writes them `local:false`,
so a freshly-migrated store correctly searches and exports as empty. That is not a port defect.

### 2026-09-15 — Drift audit, tooling added

Added `scripts/_lib/upstream-drift.js`, `scripts/workspace-drift.js`,
`.ai-config/upstream.json`, the `port-upstream` skill, and this document.
Nothing else ported yet. Measured gap at that point:

| Area | Portable new | Portable drift |
|------|--------------|----------------|
| `scripts/_lib` | 38 | 6 |
| `tests/_lib` | 37 | 4 |
| `scripts` | 31 | 10 |
| `.claude/skills` | 26 | 0 |
| `scripts/self-improvement` | 7 | 7 |
| `tests/scripts` | 4 | 6 |
| `agent/_phases` | 0 | 6 |
| `scripts/hooks` | 2 | 6 |
| `.claude/commands` | 2 | 3 |

Capability clusters behind those numbers, in dependency order:

1. **Memory store v2** — `_lib/memory-{store,tiers,embed,consolidate,migrate,board}.js`,
   `scripts/memory-{dashboard,export,mcp-server,migrate,prune-noise,setup,stow}.js`,
   `docs/reference/memory-protocol.md`. Wires into `session-start.js` (auto-import) and
   `session-stop.js` (auto-export). Largest single cluster; nothing project-coupled.
2. **Evidence / verification gates** — `_lib/{evidence,verdict,verify-gate,gate-theater}.js`,
   `scripts/record-{evidence,verdict,verification}.js`, `verify-evidence.js`. Anti-rubber-stamp
   completion gate; hooks into `post-tool-use.js` and `session-stop.js`.
3. **Ratchets** — `_lib/{ratchet,deadcode-ratchet,guard-population,refusal-ratchet,retired-terms}.js`
   plus the `ratchet:*` npm scripts. Mechanism is generic; the upstream `.txt` baselines are not —
   regenerate them here.
4. **Fleet** — `_lib/{fleet-agents,fleet-dispatch,fleet-reconcile,worker-state}.js`,
   `scripts/fleet-{dispatch,watch}.js`, `/fleet`. Zero-token cross-session worker visibility;
   `session-start.js` arms the worker.
5. **Session lifecycle** — `_lib/{session-close,session-gate,session-replay,session-state}.js`,
   `scripts/{replay,resume-sessions}.js`. Reaps yamls left "active" by a `/clear` or crash.
6. **Rule lifecycle** — `self-improvement/_core/` (6 modules), `rule-signals.ts`, `_lib/rule-rank.js`,
   and the `rules:{demote,reactivate,lifecycle-sweep,gate-theater}` scripts.
7. **PR tooling** — `_lib/pr-{media,risk,size,summary}.js`, `_lib/review-policy.js`.
8. **KB retrieval** — `_lib/kb-retrieval.js`, `scripts/{kb,doc-corpus}.js`, `docs/kb/L1/`.
9. **Smaller units** — `intent.js` + `/intent`, `bearings.js`, `engine-config.js`,
   `monitor-bands.js`, `test-integrity.js` (protected tests), `agents-md.js` (AGENTS.md
   generation), `eval-runner.js`, `sizing-accuracy.js`, `effort-weights.js`, `toon.js`,
   `json-schema-lite.js`, `mcp-footprint.js`, `dashboard-consistency.js`,
   `plan-review-loop.js`, `routing-header.js`, `summary-quality.js`, `doc-invocations.js`,
   `ci-gates.js`.
10. **Hook drift** (already present here, upstream has grown) — `post-tool-use.js` (+250 lines:
    PR verdict/summary recording, worktree pinning), `session-stop.js` (+134: memory export,
    verify-before-done, summary quality), `inject-rules-impl.js` (+79: observation injection,
    phase-scoped scoring, `alwaysInject`), `inject-context-impl.js` (+30: stale-task clearing),
    `pre-tool-use.js` (+63: zod-schema false-positive fix, protected tests, session gate),
    `session-start.js` (+37: session reaping, memory auto-import, fleet arming).

Skill candidates worth genericizing: `create-merge-branch`, `quota`, `run-dev-port`,
`self-improvement`, `worktree-sweep`, `fe-review`. Deliberately **not** ported: `verify-ticket`,
`perf-pulse`, `eng-pulse`, `bug-scorecard`, `onboarding-status`, `add-connect-institution`,
and the upstream's project-named commands (all bound to its domain, repos, or AWS
account), plus everything under its customer-, integration- and domain-specific script trees.

That leak is now closed: 474 occurrences across 30 tracked files were renamed to the
`PROJ-` prefix the repo already used elsewhere, the five suites that set `JIRA_PREFIX`
were updated to match, and `jira-story-points.js` stopped hardcoding a customer project
key in its JQL. `npm run drift:scan` over the shipped surface is clean; only untracked
local files (`.claude/settings.local.json`, the generated visualizations) still match.
