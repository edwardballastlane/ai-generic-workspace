# Spec: Per-CC-Session Task Binding (parallel-session safety)

**Author:** workspace maintainer
**Date:** 2026-05-15
**Status:** Phase A + B shipped, Phase C narrowed to docs only
**Project:** `ai-generic-workspace`
**Branches:** all on `master` (commits `d8b3aed2`, `7f9bf952`, `67bdcfc7`, `cca86a6e`)
**Jira:** n/a

> **Implementation note (2026-05-16):** Phase A (`detected-project` cache session-id gate) and Phase B (per-cc-session yaml + first-prompt rescue + update-session targeting + tooling fallthrough) are live on master and E2E-verified through the real hook scripts with parallel-session payloads. Phase C was narrowed from "remove current.yaml writes" to docs-only because keeping `current.yaml` as a back-compat mirror has zero remaining anti-pattern cost (it's always in sync with the canonical per-session yaml and no consumer reads it as an attribution source). Aggressive removal would have broken `list-projects` and `save-session-memory` when called from non-CC shells.

---

## Problem

The workspace stores active-session state in two **global** files under
`.ai-session/`:

| File | Owner | Schema |
|---|---|---|
| `current.yaml` | `./scripts/start-session` writes; `update-session` mutates | `claude_session_id`, `task.{original,refined,project,jira_ticket}`, `current.{phase,agent}` |
| `detected-project` | `inject-context-impl.js` writes when project detected from cwd/skill/prompt | single line: project slug |

Both files are read by hooks on every prompt and by tooling (`list-projects`,
`fresh-context`, `save-session-memory`, `update-session`, `inject-rules`,
`inject-context`). Because there is only one of each file on disk, two
Claude Code sessions running in parallel terminals race to overwrite them.

`scripts/hooks/user-prompt-dispatcher.js:103` already documents this exact
anti-pattern and deliberately consults neither file — Phase B generalises
that stance to the remaining 7 consumers.

### Concrete failure mode

1. Terminal A runs `./scripts/start-session quick-flow "PROJ-12550 …" my-backend`. `current.yaml.claude_session_id = A`. Session A's prompts see `yamlBound = true` → `taskJira = PROJ-12550` → events attributed to PROJ-12550 / my-backend. ✓
2. Terminal B runs `./scripts/start-session quick-flow "PROJ-13700 …" my-portal-web`. `current.yaml.claude_session_id = B`. ❌ A's binding is gone.
3. Terminal A's next prompt: `yamlBound = false` (yaml session_id ≠ A's), so it falls through to `branchJira` (per-cwd) → `promptJira` → empty. If A's branch isn't named `feature/$JIRA_PREFIX-NNNN-*`, A's events from here on carry the wrong (or no) jira_ticket.
4. The `detected-project` cache amplifies this: A and B both write to it as they detect projects from their own cwd, and the LAST writer wins. Sessions falling back to the cache pick up whichever project clobbered it most recently.

### Evidence in current data

After today's project backfill (`backfill-event-projects.ts`):
- 208 / 874 sessions had at least one event in a non-canonical project (most were the benign `(real-project, "unknown")` pattern from session-stop's no-sidecar fallback, but several are genuine cross-project contamination — e.g., session `73ec7f8e` flipping between `my-backend` and `my-portal-web` for dev A, session `28092303` flipping between `my-backend` and `ai-generic-workspace` for dev B).
- 12 sessions had multiple distinct `jira_ticket` values across their events.

### Why per-cc-session sidecars are safe (and why current.yaml is not)

`.ai-session/by-id/<session_id>.json` is keyed on the cc session_id and is the canonical state for that session. `inject-context-impl.writeSidecar` writes there atomically per prompt, and `session-stop` reads from there. **The sidecar pattern works.** The bug is that the *inputs* to writeSidecar (`yamlBound`, `trustedJira`, `project` detection) are computed from global files.

## Goals

1. Two parallel Claude Code sessions in the same workspace never corrupt each other's task / jira_ticket / project attribution.
2. No regression to single-session workflows or to tooling that reads `.ai-session/current.yaml`.
3. Backward compatible during rollout — old per-session-bound terminals continue to attribute correctly while new sessions adopt per-cc-session binding.

## Non-goals

- Don't change session-stop event format. Already keyed on session_id.
- Don't change the per-session sidecar (`by-id/<sid>.json`) shape.
- Don't introduce a daemon or lock-server.
- Don't reattribute already-written events. (Backfill is a separate, completed effort.)

## Proposed solution — staged

### Phase A (immediate, low-risk): gate the project cache by session_id

`.ai-session/detected-project` becomes a 2-line file:

```
<claude_session_id>
<project-slug>
```

Both readers — `inject-context-impl.detectProject` source-4 (around
`inject-context-impl.js:344`) and `inject-rules-impl.js:83` — must apply
the same gate:

- If line 1 ≠ current session_id, **ignore the cache** (treat as unset).
- Otherwise use line 2 as the cached project.

The cache-write call site (currently inline at `inject-context-impl.js:557`)
is extracted to a new shared helper `scripts/hooks/_lib/detected-project.js`
exporting `read(workspaceRoot, sessionId)` and `write(workspaceRoot, sessionId, project)`. Both hooks consume the helper so the 2-line parsing format lives in one place.

`session-start.js` still unlinks the file on new session (already shipped).

**Effect**: terminal B writing the cache during its prompt no longer corrupts A's fallback. The cache becomes effectively per-session without changing the file location.

**Touchpoints**:
- `scripts/hooks/_lib/detected-project.js` (new, ~40 lines)
- `scripts/hooks/inject-context-impl.js` (replace inline read + write with helper)
- `scripts/hooks/inject-rules-impl.js` (replace inline read with helper)

**Tests**: 4 new unit tests covering match / mismatch / malformed / missing.
**Risk**: ~80 lines including the helper module; reversible by reverting one commit. **Rollback caveat**: a revert leaves any session that wrote a 2-line file with malformed input on the old code path — the tolerant reader stays in the helper so even the old format works; alternatively, document that rollback requires `rm .ai-session/detected-project`.

### Phase B (medium, durable): per-session yaml under `.ai-session/by-id/`

`.ai-session/by-id/<claude_session_id>.yaml` becomes the canonical task binding for that cc session. Schema mirrors `current.yaml`:

```yaml
session:
  id: "20260515-180119"
  started: "2026-05-15T23:01:19Z"
  workflow: "quick-flow"
  status: "active"
  claude_session_id: "0293f5a3-d36b-4d3e-923f-ac313bc3d296"
task:
  original: "Investigate parallel-session bug"
  refined: "Investigate parallel-session bug"
  project: "ai-generic-workspace"
  jira_ticket: ""
current:
  phase: 3
  agent: "developer"
# … same fields as current.yaml today
```

#### Producer side
- `scripts/start-session`:
  - When `CLAUDE_SESSION_ID` is in the environment OR the latest sidecar has a session_id, write **both** `by-id/<sid>.yaml` AND `current.yaml`. Their contents are identical; current.yaml is the back-compat shim.
  - When no session_id is available (rare; the shell user invoked start-session before any prompt), write only `current.yaml` with a placeholder `claude_session_id: ""` and rely on the first prompt's inject-context to bind.
- `scripts/update-session`: when a session_id is reachable (env var or the `current.yaml.claude_session_id`), sed-edit `by-id/<sid>.yaml` and copy the result to `current.yaml`. Today's update-session uses bash `sed` — keep that, just point it at the per-session file.

#### Consumer side
- `inject-context-impl.computeYaml`: prefer `by-id/<sessionId>.yaml` when present; fall back to `current.yaml`.
- `inject-rules-impl.readProjectFromYaml`: same priority.
- `list-projects.js`: reads `current.yaml` for "what is the active session in this workspace" — kept as a workspace-wide concept. Per-session listing would take a `--session-id` flag.
- `fresh-context-impl.js`, `save-session-memory`: read `current.yaml` as today. Once Phase B is shipped these tools can opt into the per-session yaml in a follow-up.

#### State on disk after a rollout

```
.ai-session/
├── current.yaml                     # back-compat copy of the active session's yaml
├── cc-session-id                    # current cc session id (still written by session-start hook)
├── detected-project                 # session-id-gated cache (Phase A)
├── by-id/
│   ├── <sidA>.yaml                  # session A's task binding (new)
│   ├── <sidA>.json                  # session A's sidecar (already exists)
│   ├── <sidB>.yaml                  # session B's task binding (new)
│   └── <sidB>.json                  # session B's sidecar
```

#### Migration

Single-shot script reads `current.yaml` once on first prompt after the migration commit ships and writes it to `by-id/<currentSessionId>.yaml` if no per-session yaml exists yet. No data loss; idempotent.

### Phase C (cleanup, post-migration)

> **Superseded — see implementation note at top of doc.** Phase C was narrowed to docs-only after Phase B E2E verification showed `current.yaml` works as a back-compat mirror with zero anti-pattern cost (it's always in sync with the canonical `by-id/<sid>.yaml`, and no consumer reads it as an attribution source). The aggressive removal below was discarded because it would have broken tools called from non-CC shells (`list-projects`, `save-session-memory`). The doc updates portion was kept and shipped in commit `9e5117ae`.

Original proposal (rejected):

- start-session stops writing `current.yaml`; instead it writes only `by-id/<sid>.yaml` and a `current.yaml` symlink (or removes current.yaml altogether once every consumer migrated).
- `agent/_core/context-manager.md` doc updates.
- Removes the "global file" anti-pattern from the workspace.

## Acceptance criteria

**AC-1** Two terminals each running `./scripts/start-session quick-flow "X" projA` and `./scripts/start-session quick-flow "Y" projB`, then issuing at least 3 prompts each before exit, produce entries in `.ai-memory/session-end-events.jsonl` such that every event grouped by `claude_session_id` carries the matching `project` and `task` — no cross-attribution between the two cc session ids. (Phase B, blocking.)

**AC-2** `.ai-session/detected-project` cache lookups in session A return only projects written by A. Cache writes from B are ignored by A. Specifically: when `detected-project`'s first line ≠ current session_id, both `inject-context-impl.detectProject` and `inject-rules-impl.resolveProject` return their "no cached value" sentinel (project source falls through to lower-priority sources). (Phase A.)

**AC-3** `tests/hooks/inject-context.test.js` and `tests/hooks/inject-rules.test.js` each gain test cases for "yaml bound to other session" and "detected-project cached by other session". The assertion: `detectProject(...).source !== 'detected'` and `detectProject(...).project` matches the lower-priority fallback (cwd / prompt / 'unspecified'), never the other session's cached project.

**AC-4** Existing tests pass. The session-start hook still clears detected-project on new session (Phase A is additive to today's fix).

**AC-5** Backward compat: `list-projects`, `fresh-context`, `save-session-memory`, `update-session` continue to work without modification post-Phase-B because `current.yaml` is still maintained.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `update-session` sed-edits drift between per-session yaml and current.yaml | Phase B keeps update-session writing both files in sync atomically. Or port update-session to Node first to take a single write path. |
| Race condition: two terminals call start-session within ms of each other | Each writes its own `by-id/<sid>.yaml`; current.yaml race is benign because both are valid per-session shims. |
| Cleanup of stale `by-id/*.yaml` after sessions end | Hook into existing sidecar cleanup, or treat as append-only (sidecars on disk today are not actively cleaned). |
| Tests for parallel-session contamination are hard to write without a CC harness | Use a unit-test seam: spawn two `inject-context-impl` runs with different sessionId payloads and assert each writes only its own sidecar. |

## Estimated effort

| Phase | Files | Lines | Tests | Effort |
|---|---|---|---|---|
| A — cache session-id gate (helper + 2 hook callsites) | 3 | ~80 | 4 | 1.5h |
| B — per-session yaml | 4-6 | ~180 | 5 | 4h |
| C — cleanup + docs | 4-6 | ~80 | 2 | 2h |

Total ~7.5h, ship as 3 sequential PRs.

## Open questions

1. **Should `current.yaml` ever be deleted?** Phase C proposes removing it entirely; alternative is to keep it as a symlink to the most-recently-active session's yaml for tooling. Recommend: symlink — least disruption.
2. **What about `start-session` invoked before the CC session is bound (e.g., from a shell user kicking off work before opening Claude Code)?** This is actually the documented entry path (`/work-ticket` triggers `start-session`) so it is the common case, not the edge case. Today the script tries `CLAUDE_SESSION_ID` env then falls back to "latest sidecar"; with Phase B the fallback must write a placeholder `by-id/PENDING-<timestamp>.yaml` that the first inject-context call (which carries the real session_id on stdin) renames to `by-id/<realSid>.yaml`. Recommend: implement in Phase B — this branch is not optional.
3. **Should the detected-project cache survive a session restart?** Today it does (the cache file persists across CC sessions; the session-start hook now clears it). With Phase A, the cache is per-session-id, so it's effectively per-session anyway. Recommend: keep the session-start clear as defense-in-depth.

## Out of scope

- Reattribution of historical events (already handled by `backfill-event-projects.ts`).
- Distributed locking, server-mediated session state, or cross-machine session sync.
- Renaming current.yaml or moving away from YAML.
