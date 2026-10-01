# Implementation Plan — Phase 8: AWS Infra Node Port + Orphaned Test Cleanup

**Date**: 2026-05-06
**Spec**: [docs/specs/spec-2026-05-06-node-port-phase-8-aws-infra-orphaned-test.md](../specs/spec-2026-05-06-node-port-phase-8-aws-infra-orphaned-test.md) (20 ACs)
**Branch**: `feat/node-port-phase-8-aws-infra-orphaned-test` (HEAD `39a3e96`, base: Phase 7 tip `4691222`)
**Status**: Approved — ready for `/swarm-implement`

---

## Context

Phase 8 closes the bash → Node port. Three remaining categories:

1. **AWS infra scripts** (`infra/token-dashboard/{setup,deploy,teardown}.sh`, 251 lines total) — bash + AWS CLI + Python heredocs. Only viable replacement on a Node image is the **AWS SDK v3** — first time the port adds runtime npm deps (`@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`, `@aws-sdk/client-sts`).
2. **Bitbucket pipeline master deploy step** — installs `python3 pip + awscli` to call two AWS CLI commands. Phase 8 replaces with `npm run tokens:deploy`, eliminating Python entirely (~20s + ~80MB image cache savings).
3. **Orphaned bash test** (`tests/session-id-attribution.test.sh`, 515 lines, NOT wired into `npm test` or CI) — Phase 6 covered T1, T2, T3, T4, T6, T8 in Node tests. Two cases remain (T5 idempotency, T7 UUID gate); land them in `tests/scripts/reconcile-session-attribution.test.js` then `git rm` the bash file.

After Phase 8: `CLAUDE.md` "Node port complete" cites Phases 1–8.

---

## Task list (6 tasks)

| ID | Task | Owner files | Deps | Est. | ACs |
|----|------|-------------|------|------|-----|
| **T1** | Port `deploy.sh` (40 lines) → `infra/token-dashboard/deploy.js`. `S3Client.PutObjectCommand` (`ContentType: 'text/html'`, `CacheControl: 'max-age=300'`); `CloudFrontClient.CreateInvalidationCommand` (`Paths: { Quantity: 1, Items: ['/*'] }`, `CallerReference: Date.now().toString()`); `loadEnv()` reads `infra/token-dashboard/.env` OR falls back to `S3_BUCKET` / `CLOUDFRONT_DIST_ID` env vars (CI path); missing-file guard with stderr hint. | `infra/token-dashboard/deploy.js` (new, ~80 lines) | — | 1.5h | AC-4, AC-5, AC-6, AC-7 |
| **T2** | Port `setup.sh` (138 lines) → `infra/token-dashboard/setup.js`. `STSClient.GetCallerIdentityCommand` resolves account ID; `S3Client.{CreateBucket,PutPublicAccessBlock,PutBucketPolicy}`; `CloudFrontClient.{CreateOriginAccessControl,CreateDistribution}`; distribution config matches `setup.sh:34-81` verbatim; writes `.env` with `0o600` perms. Idempotency: catch `BucketAlreadyOwnedByYou` / `BucketAlreadyExists`. Credential error: catch and print actionable stderr. | `infra/token-dashboard/setup.js` (new, ~150 lines) | — | 3h | AC-1, AC-2, AC-3 |
| **T3** | Port `teardown.sh` (73 lines) → `infra/token-dashboard/teardown.js`. `node:readline` y/N prompt; ETag dance: `GetDistributionConfig` → `Enabled = false` → `UpdateDistribution` → `waitUntilDistributionDeployed({ maxWaitTime: 1200 })` → fresh `GetDistributionConfig` → `DeleteDistribution`; OAC ETag → `DeleteOriginAccessControl`; paginated `ListObjectsV2` + `DeleteObjects` + `DeleteBucket`; `fs.unlinkSync('.env')`. Missing-`.env` guard. | `infra/token-dashboard/teardown.js` (new, ~150 lines) | — | 3h | AC-8, AC-9, AC-10 |
| **T4** | Orphaned-test cleanup. Append two `test(...)` blocks to `tests/scripts/reconcile-session-attribution.test.js` after AC-24: (a) **T5 idempotency** — split-attribution fixture, run `--apply` once, capture file content `before`, run `--apply` again, assert content `after === before`; (b) **T7 malformed UUID** — fixture event with `session_id: '*-not-a-uuid'`, run script, assert `r.status === 0`, `r.stderr === ''`, plus inline sanity check `UUID_RE.test('*-not-a-uuid') === false`. Then `git rm tests/session-id-attribution.test.sh`. | `tests/scripts/reconcile-session-attribution.test.js` (extend), `tests/session-id-attribution.test.sh` (delete) | — | 1h | AC-15, AC-16, AC-17 |
| **T5** | Cross-cutting wiring (4 mechanical edits): (a) `package.json` `dependencies` add `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`, `@aws-sdk/client-sts`; (b) `package.json` `scripts` add `tokens:deploy`, `tokens:setup`, `tokens:teardown`; (c) `bitbucket-pipelines.yml` deploy step replaces lines 26–31 with `apt-get install -y git`, `npm ci`, `npm run tokens:dashboard`, `npm run tokens:deploy` (zero `python` / `pip` / `awscli` substrings); (d) `CLAUDE.md` "Node port complete" Phases 1–7 → 1–8; add Phase 8 row. Pre-flight: `node --check` on all 3 new `.js` files. Run `npm install` to update lockfile. | `package.json`, `package-lock.json`, `bitbucket-pipelines.yml`, `CLAUDE.md` | T1, T2, T3 | 1h | AC-11, AC-12, AC-13, AC-14, AC-18, AC-19 |
| **T6** | Smoke + reviewer. `npm install` (verify three `@aws-sdk/*` resolve); `npm test` (target ≈ 212 tests = 210 baseline + 2 new); `node --check` on the 3 new infra `.js`; `git status --short` clean; `git ls-files tests/session-id-attribution.test.sh` returns nothing; `grep -E 'python\|pip\|awscli' bitbucket-pipelines.yml` returns 0 in the Deploy step; `CLAUDE.md` greps for "Phases 1–8". Reviewer reviews against all 20 ACs. | none (read-only/test) | T5 | 1.5h | AC-20, gate for all 20 |

**Critical path**: max(T1, T2, T3, T4) = 3h → T5 (1h) → T6 (1.5h) = **5.5h**.

T1, T2, T3, T4 are independent — Wave 1 fans them out at once.

---

## Wave plan — 3 waves, peak 4-way concurrency

### Wave 1 — 4 parallel implementers

| Teammate | Agent type | Task | Files owned |
|----------|-----------|------|-------------|
| `deploy-impl` | implementer | **T1** (1.5h) | `infra/token-dashboard/deploy.js` |
| `setup-impl` | implementer | **T2** (3h) | `infra/token-dashboard/setup.js` |
| `teardown-impl` | implementer | **T3** (3h) | `infra/token-dashboard/teardown.js` |
| `orphaned-test-impl` | implementer | **T4** (1h) | `tests/scripts/reconcile-session-attribution.test.js` (extend), `tests/session-id-attribution.test.sh` (delete) |

**Sync gate**: Wait for ALL 4 commits before Wave 2.

### Wave 2 — 1 sequential (depends on T1 + T2 + T3)

| Teammate | Agent type | Task |
|----------|-----------|------|
| `cross-cutting-impl` | implementer | **T5** (`package.json` deps + scripts + lockfile + `bitbucket-pipelines.yml` + `CLAUDE.md`) |

### Wave 3 — Reviewer + Smoke (parallel)

| Teammate | Agent type | Task |
|----------|-----------|------|
| `phase8-reviewer` | reviewer | All 20 ACs review (read-only) |
| `phase8-smoke` | tester | **T6** (`npm install` + `npm test` + `node --check` + AC mapping + pipeline grep gate) |

---

## Wall-clock estimate

| Time | Event |
|------|-------|
| t=0 | Wave 1 starts: T1 ∥ T2 ∥ T3 ∥ T4 |
| t=1h | T4 done |
| t=1.5h | T1 done |
| t=3h | T2 + T3 done → Wave 2 (T5) |
| t=4h | T5 done → Wave 3 |
| t=5.5h | T6 + reviewer done; ready for `/pre-push` |
| **Total** | **~5.5 h elapsed** vs ~9.5 h serial |

---

## Verification

### Local
1. `npm install` — adds the three `@aws-sdk/*` packages; `package-lock.json` updates.
2. `npm test` — target ≈ 212 tests. All green.
3. `node --check infra/token-dashboard/{setup,deploy,teardown}.js`.
4. **AC-11**: `grep -E 'python|pip|awscli' bitbucket-pipelines.yml` against the Deploy Token Dashboard step → 0 matches.
5. **AC-17**: `git ls-files tests/session-id-attribution.test.sh` returns nothing.
6. `git diff master..HEAD --stat` — expect ~10 files touched (3 new infra .js, 1 test file modified, 1 test bash file deleted, package.json, package-lock.json, bitbucket-pipelines.yml, CLAUDE.md, plan/spec docs).

### CI (AC-20)
- `cross-os-smoke.yml` matrix runs `npm test` on `ubuntu-latest`, `macos-latest`, `windows-latest`. AWS SDK v3 is pure JS (no native bindings) — installs cleanly cross-OS. New tests do not require AWS credentials.

### Live (post-merge, optional)
- Trigger a master push; observe Bitbucket deploy step finishes ~20s faster with no `python3` / `pip` / `awscli` log lines.

---

## Reused utilities

| Utility | Source | Used by |
|---------|--------|---------|
| `node:readline` (interactive y/N) | stdlib (matches `scripts/setup.js` Phase 7 pattern) | T3 |
| `node:fs` (`.env` read/write, `0o600` perms) | stdlib | T1, T2, T3 |
| `tempdir` + `EVENTS_FILE_OVERRIDE` test pattern | `tests/scripts/reconcile-session-attribution.test.js` AC-21..AC-24 | T4 (extends same file) |
| `UUID_RE` reference | `scripts/reconcile-session-attribution.js:50` | T4 (T7 inline sanity check) |

**Note**: NO `_lib/` utilities created. NO bash stubs / `.cmd` siblings (intentional policy difference from Phases 1–7 — see spec §5.9).

---

## Constraints — non-negotiable

1. CommonJS only: `'use strict';`, `module.exports`, `require()`. No ESM.
2. `node:` prefix on stdlib imports. AWS SDK packages use unprefixed scoped names per their published API.
3. AWS SDK v3 packages pinned `^3.x` — implementer runs `npm install @aws-sdk/client-s3@latest` etc. to resolve actual latest at install time.
4. **No SDK mocking in tests.** T4 only adds tests for `scripts/reconcile-session-attribution.js`, not for new infra scripts (spec §3).
5. **No `python3` / `pip` / `awscli` substrings** in `bitbucket-pipelines.yml` Deploy Token Dashboard step (AC-11 grep gate).
6. **No bash stubs / `.cmd` siblings** for the 3 infra `.js` files (spec §5.9).
7. **No `dotenv` dependency.** `.env` parser is a 4-line `key=value` split (spec §5.2).
8. `waitUntilDistributionDeployed` `maxWaitTime: 1200` override — do not rely on SDK default (3600s) (spec R-4).
9. Commit footers cite ACs: `Closes AC-X, AC-Y`.
10. Distribution config in `setup.js` mirrors `setup.sh:34-81` exactly (`PriceClass_100`, cache policy ID `658327ea-f89d-4fab-a63d-7e88639e58f6`, custom errors). Do NOT modify.

---

## Risks (carried from spec §8)

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | New runtime deps add ~600 KB to `node_modules` | Net win: eliminates ~80 MB Python + awscli on runner |
| R-2 | AWS SDK v3 → v4 future churn | Pin `^3` only; major upgrade is its own PR |
| R-3 | Pipeline missing required env vars | Already present for bash step; document in PR |
| R-4 | `waitUntilDistributionDeployed` default 3600s | Override to 1200s in `teardown.js` |
| R-5 | `ContentType` charset divergence | Explicit `'text/html'` in `PutObjectCommand` |
| R-6 | Reconcile script may always rewrite events file | T4 reads apply path before writing T5; assert content equality |
| R-7 | T6 in bash test (audit on reconciled file) not ported | Already covered by AC-22 / AC-9 transitively |

---

## Open considerations

- **Phase 7 PR #6 still open** — Phase 8 PR is deeper-stacked. Don't open Phase 8 PR before PR #6 is mergeable on remote.
- **`pre-tool-use` hook self-block**: commit bodies containing literal `git push` get flagged. Reword; do NOT use `--no-verify`.
- **`package-lock.json` MUST be committed** alongside `package.json` in T5.
- **AWS_REGION default `us-east-1`** matches bash; honor `AWS_REGION` env override.

---

## Out of scope (spec §3)

- Changing dashboard data shape, HTML output, chart layout, bucket name pattern, distribution config, IAM policy.
- Modifying `.agents/skills/ui-ux-pro-max/scripts/*.py`.
- Removing `python3` from non-deploy steps.
- Mocking AWS SDK in tests.
- Bash stubs / `.cmd` siblings for infra Node scripts.
- Changing `.env` schema.

---

## Execute

```bash
/swarm-implement docs/plans/plan-2026-05-06-node-port-phase-8-aws-infra-orphaned-test.md
```
