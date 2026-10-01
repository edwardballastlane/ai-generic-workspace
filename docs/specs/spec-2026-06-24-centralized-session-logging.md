# Spec: Centralized session logging (capture every session, any directory)

**Status:** Proposal
**Date:** 2026-06-24
**Author:** Steve Bujouves (with Claude)
**Related:** `scripts/hooks/session-stop.js`, `scripts/_lib/session-events.js`, `scripts/token-dashboard.js`

## Problem

The token/cost dashboard silently under-reports because session logging is tied to **where Claude Code is launched**. A two-week investigation (Jun 2026) found one user's sessions missing from the dashboard after Jun 11; the data was not "lost in a merge" — it was **never captured**. Three independent failure modes combined:

1. **The Stop hook is project-local with a relative command.** It is registered only in this repo's `.claude/settings.json` as `node ./scripts/hooks/session-stop.js`. Claude Code applies a project's settings only to sessions launched **in that project**, and the relative path resolves against `cwd`. So sessions started in *any other directory* (e.g. `lane-internal-docs-github`, `lane-external-docs-github`, or the `lane-customer` project — which symlinks to the non-git parent `Repos/` folder) **never run the hook at all** and produce **zero** events.
   - Evidence: in the gap window, 7 sessions ran from internal-docs and 1 from external-docs (surviving transcripts), none logged anywhere.

2. **The events directory is `cwd`-relative.** `session-stop.js` uses `ROOT = process.cwd()` and writes to `ROOT/.ai-memory`. Even if the hook *did* run elsewhere, events would scatter into each repo's `.ai-memory` (or nowhere — the `lane-customer` target isn't a git repo and has no `.ai-memory`), never reaching the one clone the dashboard reads.

3. **The hook committed but never pushed** (fixed 2026-06-24, commit on `master`): events that *were* captured sat in unpushed local commits. A clone that fell behind on the hook itself (stale by ~100 commits) stopped committing entirely until a pull. The dashboard reads the **pushed** file, so it froze at the last pushed event.

Net effect: only sessions launched **inside the `ai-generic-workspace` clone, by a current+pushed hook** ever reach the dashboard. Everything else is invisible, with no signal that it's missing.

## Goal

Capture **every** Claude Code session's `session_end` event — regardless of which directory it was launched from — into one canonical, pushed location the dashboard reads. Make drift **observable** rather than silent.

## Non-goals

- Changing the event schema or the dashboard's aggregation/de-cumulation.
- Capturing sessions from machines that never sync to git (out of scope; see safety net).

## Proposed design

### 1. Global hook with an absolute command
Register the Stop hook in **`~/.claude/settings.json`** (global) with an **absolute** path to `session-stop.js` in the canonical clone, so it fires for sessions in *any* directory. Keep the project-level registration removed (or guarded) to avoid double-firing.

```jsonc
// ~/.claude/settings.json
"Stop": [{ "hooks": [{ "type": "command",
  "command": "node /Users/<you>/…/ai-generic-workspace/scripts/hooks/session-stop.js",
  "timeout": 5000 }] }]
```

Bootstrap (`scripts/setup`) writes this with the machine's resolved clone path.

### 2. Canonical events root, independent of `cwd`
Introduce `LANE_EVENTS_ROOT` (env, default = the canonical clone path baked in at setup). `session-stop.js` writes events, and runs `autoCommit`/`autoPush`, against **that root** — not `process.cwd()`. `cwd` is still recorded *as a field* (`project`/launch dir) for attribution, but never decides *where* the log lives.

- `EVENTS_DIR = path.join(LANE_EVENTS_ROOT, '.ai-memory')`
- `autoCommit({ root: LANE_EVENTS_ROOT, … })`, `autoPush({ root: LANE_EVENTS_ROOT })`
- Fall back to `process.cwd()` only if `LANE_EVENTS_ROOT` is unset (preserves current behavior for un-migrated clones).

### 3. Keep the auto-push (already shipped) + concurrency note
`autoPush` is in place (guarded, detached, opt-out via `SESSION_AUTOPUSH=0`). With a global hook, many repos now push to the same clone; non-fast-forward rejections are already handled (commit stays local, next session carries it). Consider a tiny jittered retry-on-rejection (pull --rebase --autostash then push) **only** inside the canonical clone.

### 4. Observability: a coverage health-check
Add `npm run tokens:coverage` (and a dashboard banner) that reports **last-event-age per user**. If a user's newest event is older than N days, flag it. This converts silent drift into a visible alert — the single thing that would have caught this in week one.

### 5. Safety net: reconcile from transcripts
Productize the one-shot backfill used to recover the Jun 17–24 data into `scripts/reconcile-session-events-from-transcripts.js`: scan `~/.claude/projects/*/`, and for any transcript whose `session_id` has no event, rebuild it (reusing `readTranscript`/`computeCostUsd`, dated to the transcript's real end time). Run it on a schedule or in the dashboard pipeline so anything the live hook still misses is recovered while transcripts survive (note: CC prunes transcripts, so this is best-effort and time-bounded).

## Migration / rollout

1. Land `LANE_EVENTS_ROOT` support in `session-stop.js` (with `cwd` fallback) + tests.
2. Update `scripts/setup` to (a) install the global hook with absolute paths and (b) export `LANE_EVENTS_ROOT`. Document opt-out.
3. Add `tokens:coverage` + the reconcile script.
4. Backfill once from transcripts (done for the original report; re-run across all users).

## Risks & mitigations

- **Double-firing** (global + project hook): remove the project-level Stop hook, or have the hook no-op when invoked twice for the same `session_id` (sidecar dedupe by ts).
- **Push contention** across many repos: already tolerated (rejections are harmless); optional jittered rebase-retry.
- **Wrong/secret repo as cwd**: events always go to the canonical clone, never the cwd repo, so no stray `.ai-memory` is created in unrelated projects.
- **Absolute path differs per machine**: resolved at setup time, not hardcoded in git.

## Appendix: evidence from the Jun 2026 incident

- Stale hook + no push → user's events uncommitted Jun 13–23; full-history pickaxe found **no** commit ever contained them.
- 16 sessions recovered from surviving transcripts (Jun 17–24, ~$416 at corrected pricing); Jun 13–16 transcripts already pruned.
- Sessions confirmed running from ≥3 project dirs; only `ai-generic-workspace` had logging plumbing.
