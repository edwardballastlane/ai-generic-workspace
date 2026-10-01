# Specification: Anti-Rubber-Stamp Gate — verifier-verdict theater detection

**Author**: Spec Writer
**Date**: 2026-08-03
**Status**: Ported — detector and CLIs shipped; consensus-panel wiring pending (see §3)
**Project**: Lane framework
**Origin**: Adapted from a prior-art approval-rate gate (referred to below as *the reference implementation*).

---

## 1. Goal and Context

Lane's `/swarm-implement` accepts each implementation task only after an independent
consensus panel (Step 4.5) votes PASS. But nothing observes the *panel itself*. If the
verifiers drift into always voting PASS — because prompts weaken, the model gets agreeable,
or the tasks are easy — the gate silently stops carrying information. A gate that never
fails is not a gate; it is ceremony.

The reference implementation solved the analogous problem with a gate that flags when an
approval process's accept-rate is suspiciously high. This spec ports that idea into Lane,
adapted to Lane's existing `value-events.jsonl` event spine and hardened against the
weakness that the reference implementation's own detector has (see §6).

**Non-goal:** changing how the panel votes, or blocking a merge automatically. This is an
*observability + alerting* feature. It reports; humans (or CI, opt-in) act.

## 2. Design Decision

Three pieces, all leaning on infrastructure Lane already has:

1. **Record verdicts.** After the Step 4.5 panel tallies each task (final verdict, post
   retries), the orchestrator appends a `verifier_verdict` value-event via a small CLI.
   This reuses `scripts/hooks/value-logger.js` and lands in `.claude/logs/value-events.jsonl`
   alongside the existing `rule_injection` / `session_search` events (git-tracked, union
   merge driver).

2. **Detect theater.** A pure, injectable detector evaluates the recent window of verdicts:
   theater is flagged when, over at least `minDecisions` decisions, the PASS-rate is at or
   above `rateThreshold`. A zero-FAIL window is called out explicitly (`never-fails`) so it
   is not mistaken for a merely-high rate.

3. **Report.** A CLI reads the log and prints overall + per-project + per-panel verdicts,
   with an opt-in `--strict` exit code for CI.

### Verdict event shape

```json
{
  "timestamp": "2026-08-03T…Z",
  "sessionId": "…",
  "type": "verifier_verdict",
  "count": 1,
  "details": {
    "taskId": "T-3",
    "verdict": "PASS",
    "panel": "generic",
    "panelists": 3,
    "passVotes": 3,
    "blockers": 0,
    "retry": 0,
    "project": "my-project"
  }
}
```

### Detector semantics (defaults)

| Knob | Default | Meaning |
|------|---------|---------|
| `minDecisions` | 8 | Below this, return `insufficient-data` (never theater). |
| `rateThreshold` | 0.95 | PASS-rate ≥ this over the window ⇒ theater. |
| `windowSize` | 30 | Only weigh the most recent N verdicts (0/null = all). |

`reason` ∈ `insufficient-data` | `never-fails` | `pass-rate-above-threshold` | `healthy`.

## 3. Implementation (as shipped)

| File | Change |
|------|--------|
| `scripts/_lib/gate-theater.js` | Pure detector: `detectTheater`, `detectByGroup`, `isPass`, `recentWindow`, frozen `DEFAULTS`. No I/O, injected clock/state. |
| `scripts/record-verdict.js` | CLI — appends one `verifier_verdict` event via `value-logger`. |
| `scripts/gate-theater-report.js` | CLI — reads `value-events.jsonl`, runs the detector overall + grouped by project + panel; `--json`, `--window`, `--threshold`, `--min`, `--strict`. |
| `tests/_lib/gate-theater.test.js` | 10 `node:test` cases (fixtures, no I/O). |
| `package.json` | `rules:gate-theater` script → `node scripts/gate-theater-report.js`. |

**Not yet wired in this workspace.** The `/swarm-implement` consensus panel does not call
`record-verdict.js`, so the only producer of `verifier_verdict` events here is the pre-PR
gate in `post-tool-use.js` and the `verify-gate` CLI. Until `.claude/commands/swarm-implement.md`
(step 4.5) and `.claude/agents/verifier.md` are updated, `gate-theater-report` has no
consensus-panel data to group by and will report `insufficient-data` for that panel.

## 4. Acceptance Criteria

- [x] AC-1: A `verifier_verdict` event is appended to `value-events.jsonl` by `record-verdict.js`.
- [ ] AC-1b: The `/swarm-implement` consensus panel actually calls it (wiring not ported).
- [x] AC-2: `detectTheater` returns `insufficient-data` below `minDecisions` and never flags theater there.
- [x] AC-3: A window that is entirely PASS over ≥ `minDecisions` is flagged `theater` with reason `never-fails`.
- [x] AC-4: A PASS-rate ≥ `rateThreshold` (with some fails) is flagged `theater` with reason `pass-rate-above-threshold`.
- [x] AC-5: A window with regular fails below threshold is `healthy`.
- [x] AC-6: `windowSize` bounds evaluation to the most recent N decisions.
- [x] AC-7: `detectByGroup` isolates an always-PASS project/panel from healthy ones.
- [x] AC-8: `gate-theater-report.js --strict` exits non-zero when overall theater is detected, 0 otherwise.
- [x] AC-9: Full suite green (`npm test`).

## 5. Detector is pure + injectable (reference pattern)

`gate-theater.js` reads no disk, clock, or network — the verdict list and all knobs are
passed in. This is deliberately the reference pattern for making Lane's TS learning core
testable the same way.

## 6. Hardening over the reference implementation

The reference implementation keys purely on approval *rate* and is itself gameable — decline
1-in-10 to stay under the bar — and it measures rate, not review depth. Lane's version
additionally:

- Surfaces `never-fails` as a distinct, louder signal.
- Exposes per-project and per-panel breakdowns (`detectByGroup`) so a single always-PASS
  slice cannot hide inside a healthy aggregate.

Remaining limitation (documented, not fixed here): like the reference implementation, this measures *outcomes*,
not *review depth*. A panel that reads nothing but occasionally FAILs still reads "healthy."
Depth instrumentation (did the verifier actually run the cited checks?) is future work and
folds naturally into [idea #1, evidence-based completion](spec-2026-08-03-evidence-based-completion.md).

## 7. Risks

- **Sparse data early.** Until enough swarm runs accumulate, most reports are
  `insufficient-data`. Acceptable — better than a false alarm.
- **Recording depends on the orchestrator.** If Step 4.5's `record-verdict.js` call is
  skipped, the gate has no data. Mitigated by wiring it into the command doc at the exact
  tally step; a future hook could enforce it.
