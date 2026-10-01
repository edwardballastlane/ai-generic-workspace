# Specification: Evidence-Based Completion — machine evidence behind "done"

**Author**: Spec Writer
**Date**: 2026-08-03
**Status**: Draft — Ready for `/breakdown`
**Project**: Lane framework
**Origin**: Adapted from a prior-art verified-completion model (referred to below as *the reference implementation*).

---

## 1. Goal and Context

Today a Lane task is "done" when the model says so. The `verification-before-completion`
norm and the Step 4.5 consensus panel raise the bar, but neither produces **durable,
auditable evidence**: there is no captured artifact, no hash, no chain tying a "done" claim
to a command that actually ran and passed.

The reference implementation's core discipline is the opposite: the orchestrator *cannot* self-attest completion.
Each scope item ships only with captured probe artifacts (test/boot output), each hashed
with sha256, and a completion check re-validates that the cited artifact exists and matches.
"No certificate, no ship."

This spec brings the **evidence** half of that discipline to Lane — without the standalone
engine — so a "done" claim references a real, hashed artifact that a human or CI can inspect.
It deliberately imports the *hardened* version (see §6): compare captured **output**, not
just exit code, and tie evidence to a **specific acceptance criterion**, not a whole suite.

**Non-goals:**
- Cross-family certification (a larger, separate lift).
- Blocking merges automatically. This produces and verifies evidence; enforcement policy is separate.

## 2. Current State

- `agent/_core/definition-of-done.md` — cross-role DoD gate, prose only, no evidence capture.
- Step 4.5 of `/swarm-implement` — consensus panel votes on the *diff*, not on captured runs.
- `scripts/hooks/value-logger.js` + `.claude/logs/value-events.jsonl` — existing structured
  event spine (used by [idea #3](spec-2026-08-03-anti-rubber-stamp-gate.md)'s `verifier_verdict`).
- `scripts/_lib/process.js` — `atomicWrite`, `withFileLock` for safe artifact writes.

No component captures command output to disk, hashes it, or cites it in a completion record.

## 3. Design Decision

Introduce an **evidence record** per completed task/criterion:

1. **Capture.** When a task claims done, the responsible agent runs the relevant check
   (targeted tests / type-check / build for the touched files) and writes stdout+stderr to
   `.ai-memory/evidence/<task-id>/<criterion-id>.log`.
2. **Hash.** Compute `sha256` of each artifact.
3. **Record.** Append a `completion_evidence` value-event citing: task id, criterion id,
   command run, exit code, artifact path, artifact sha256, and a short pass/fail assertion.
4. **Verify.** A `verify-evidence` step (and the Step 4.5 panel) re-reads the cited artifact,
   re-hashes it, and confirms (a) the hash matches, and (b) the artifact's content shows the
   claimed result — **not merely that a process exited 0**.

### Evidence event shape

```json
{
  "type": "completion_evidence",
  "count": 1,
  "details": {
    "taskId": "T-3",
    "criterionId": "AC-2",
    "command": "npx jest currency.spec.ts",
    "exitCode": 0,
    "artifact": ".ai-memory/evidence/T-3/AC-2.log",
    "sha256": "…",
    "assertion": "3 passed, 0 failed, 0 skipped",
    "project": "my-project"
  }
}
```

### Proposed files

| File | Change |
|------|--------|
| `scripts/_lib/evidence.js` | Pure + injectable: `hashArtifact(buf)`, `buildRecord({...})`, `verifyRecord(record, readFile)` — re-hash + content-assertion check. No I/O in the pure core; I/O injected. |
| `scripts/record-evidence.js` | CLI — run a command, capture output to the evidence dir, hash, append `completion_evidence` event. |
| `scripts/verify-evidence.js` | CLI — re-validate all evidence records for a task; exit non-zero on hash mismatch or failed assertion. |
| `tests/_lib/evidence.test.js` | `node:test`, fixtures only (mirrors the gate-theater pattern). |
| `agent/_core/definition-of-done.md` | DoD now requires ≥1 evidence record per acceptance criterion before "done". |
| `.claude/commands/swarm-implement.md` | Step 4.5 / Step 5 cite `verify-evidence.js`. |
| `package.json` | `evidence:verify` script. |

## 4. Acceptance Criteria

- [ ] AC-1: `record-evidence.js` runs a command, writes its combined output to `.ai-memory/evidence/<task>/<criterion>.log`, and appends a `completion_evidence` event with a correct sha256.
- [ ] AC-2: `verify-evidence.js` re-hashes the cited artifact and fails on any mismatch.
- [ ] AC-3: Verification checks the **artifact content** against the claimed assertion, not just the recorded exit code (a `0 tests collected` / `|| true` pass is rejected).
- [ ] AC-4: Evidence is keyed per **acceptance criterion**, not per suite; one criterion's evidence cannot certify another.
- [ ] AC-5: The DoD doc requires evidence for each criterion; the swarm command invokes verification before reporting done.
- [ ] AC-6: `evidence.js` core is pure + injectable and fully unit-tested; `npm test` stays green.
- [ ] AC-7: Evidence dir is gitignored by default (or documented as ephemeral) — it must not bloat the repo.

## 5. Rollout

1. Ship the lib + CLIs + tests (no behavior change yet).
2. Wire into `/swarm-implement` and the DoD doc as advisory.
3. Flip to required once a few real tasks have produced evidence and the format has settled.

## 6. Hardening over the reference implementation

- **Content, not exit code.** the reference implementation's re-derivation compares only the exit code. AC-3
  mandates a content assertion so hollow greens are caught.
- **Per-criterion, not per-suite.** the reference implementation's probe→item map is orchestrator-supplied and
  only checked for ID existence, so one green suite can certify unrelated items. AC-4 ties
  each artifact to a single criterion.
- **Hash the real artifact.** Re-hash on verify (AC-2) so a record cannot cite a
  since-changed file.

## 7. Risks

- **Capture cost.** Running real checks per criterion adds wall-clock. Mitigate by scoping
  checks to touched files (Lane already routes by file count) and caching within a wave.
- **Evidence sprawl.** Logs accumulate under `.ai-memory/evidence/`. Gitignore + a prune in
  `session-stop` or `log-rotate` (Lane already has `scripts/_lib/log-rotate.js`).
- **Assertion brittleness.** Parsing "3 passed" varies by runner. Start with exit-code +
  a substring the agent supplies from the run; refine per stack over time.
