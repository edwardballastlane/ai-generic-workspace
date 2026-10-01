# Specification: Node Port — Phase 8: AWS Infra Scripts + Orphaned Bash Test

**Author**: Spec Writer
**Date**: 2026-05-06
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch**: `feat/node-port-phase-8-aws-infra-orphaned-test` (base: Phase 7 tip `4691222`)
**Spec path**: `docs/specs/spec-2026-05-06-node-port-phase-8-aws-infra-orphaned-test.md`
**Jira**: n/a

---

## 1. Problem Statement

Two categories of work remain outside Phases 1–7.

### AWS infra scripts still require bash + Python + awscli

`infra/token-dashboard/setup.sh` (138 lines), `infra/token-dashboard/deploy.sh` (40 lines), and `infra/token-dashboard/teardown.sh` (73 lines) are the only remaining bash scripts that do real work (none of them are stubs).

The Bitbucket master deploy step (`bitbucket-pipelines.yml:27-31`) installs `python3 pip` and `awscli` solely to call two AWS CLI commands — `s3 cp` and `cloudfront create-invalidation`. This adds approximately 20 s of wall-clock to every master push and pulls a full Python toolchain onto a `node:20-slim` image. Phase 7 removed `python3` from the dashboard generation step but explicitly left the deploy step with `python3 pip + awscli` (`spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md` §3, Non-Goal: "Removing python3 pip install from bitbucket-pipelines.yml line 25"). Phase 8 closes that gap.

`setup.sh` and `teardown.sh` also use Python heredoc one-liners (`setup.sh:88-89`, `teardown.sh:38`) purely for JSON parsing of AWS CLI output — the only reason Python appeared there in the first place. Windows developers cannot run any of the three scripts natively.

### Orphaned bash test is dead weight

`tests/session-id-attribution.test.sh` (515 lines) is not wired into `npm test` or any CI step. It documents eight test cases (T1–T8). Phase 6 produced Node ports of the scripts under test (`tests/scripts/audit-session-attribution.test.js` covering AC-5..AC-9, `tests/scripts/reconcile-session-attribution.test.js` covering AC-21..AC-24), but two cases were left uncovered:

- **T5** (`tests/session-id-attribution.test.sh:169-175`): re-running `--apply` produces a byte-identical file (idempotency).
- **T7** (`tests/session-id-attribution.test.sh:183-198`): a malformed `session_id` containing shell-glob chars (e.g., `*-not-a-uuid`) is rejected by the `UUID_RE` gate at `scripts/reconcile-session-attribution.js:73` (`if (!UUID_RE.test(sid)) return null`) and causes no stderr noise.

The bash test file references `.sh` files that are now 2-line stubs. It cannot run without `jq` and a bash environment with process-substitution support.

**Who is affected**: CI pipeline (20 s overhead per master push), Windows developers (cannot provision/teardown AWS infra natively), and anyone auditing test coverage (the bash test file appears as a test artifact but is unreachable by `npm test`).

**Impact of not solving**: The "Node port complete — Phases 1–7" claim in `CLAUDE.md:139` remains incorrect while three bash scripts that provision production infrastructure and a dead 515-line test file sit in the repo.

---

## 2. Goals

1. **Port `infra/token-dashboard/deploy.js`** — replace the AWS CLI `s3 cp` + `cloudfront create-invalidation` bash commands using `@aws-sdk/client-s3` and `@aws-sdk/client-cloudfront`. This is the **first time** the Node port introduces new runtime npm dependencies; `@aws-sdk/client-s3` and `@aws-sdk/client-cloudfront` are added to `dependencies` (not `devDependencies`). Rationale: the AWS SDK v3 is the only viable replacement for `awscli` on a Node image; hand-rolling SigV4-signed HTTP requests is too brittle to maintain.

2. **Port `infra/token-dashboard/setup.js`** — replace the AWS CLI `sts get-caller-identity`, `s3api create-bucket`, `s3api put-public-access-block`, `cloudfront create-origin-access-control`, `cloudfront create-distribution`, and `s3api put-bucket-policy` calls (eliminating Python heredocs at `setup.sh:88-89`). Write `.env` via `fs.writeFileSync` with `0o600` permissions.

3. **Port `infra/token-dashboard/teardown.js`** — replace the AWS CLI `get-distribution-config`, `update-distribution`, `wait distribution-deployed`, `delete-distribution`, `delete-origin-access-control`, `s3 rm --recursive`, `delete-bucket` commands (eliminating the Python heredoc at `teardown.sh:38`). Port the interactive `read -p` confirmation via `node:readline`.

4. **Update `bitbucket-pipelines.yml` master deploy step** — replace the 5-line Python/pip/awscli block with `npm run tokens:deploy` (invokes `node infra/token-dashboard/deploy.js`), eliminating `python3 pip awscli` from the pipeline entirely.

5. **Port T5 and T7 into `tests/scripts/reconcile-session-attribution.test.js`** (extend the existing file; do not create a new test file), then `git rm tests/session-id-attribution.test.sh`.

6. **Update `CLAUDE.md`** — change "Phases 1–7" → "Phases 1–8" on the "Node port complete" line; add the Phase 8 row to the phase reference table.

7. **Update `package.json`** — add `tokens:deploy` script (and optionally `tokens:setup` / `tokens:teardown` for local-dev symmetry); add `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`, and `@aws-sdk/client-sts` to `dependencies`.

---

## 3. Non-Goals

- Changing the dashboard's data shape, HTML output, or chart layout.
- Changing the bucket name pattern (`${WORKSPACE_NAME}-token-dashboard-${AWS_ACCOUNT_ID}`).
- Changing the CloudFront distribution config (price class `PriceClass_100`, cache policy ID `658327ea-f89d-4fab-a63d-7e88639e58f6`, custom error responses — all preserved verbatim from `setup.sh:64-78`).
- Modifying `infra/token-dashboard/iam-policy.json` — it is the deploy user's least-privilege policy reference document; read it for context, do not modify it.
- Adding or modifying `.agents/skills/ui-ux-pro-max/scripts/*.py` (skill-internal, not workspace tooling).
- Removing the `python3` install line from the **test** step in `bitbucket-pipelines.yml` — there is no such line; only the deploy step has it.
- Adding unit tests that mock the AWS SDK (low-value; infra smoke tests assert the script is `require`-able and rejects missing env vars cleanly).
- Creating bash stubs (`.sh` + `.cmd` siblings) for the three new infra Node scripts — these are local-dev / CI-driven one-shots, not user-facing CLIs that need cross-OS shebang wrappers. This is an explicit policy difference from Phases 1–7: infra scripts run on the Bitbucket Pipelines master step and on developer machines directly via `node infra/token-dashboard/<name>.js`; no bash backwards-compat layer is needed.
- Changing `.env` key names (`BUCKET_NAME`, `DIST_ID`, `DIST_DOMAIN`, `OAC_ID`) — the deploy and teardown scripts depend on this schema.

---

## 4. Acceptance Criteria

### setup.js (3 ACs)

**AC-1** — Given valid AWS credentials and no existing bucket, when `node infra/token-dashboard/setup.js` runs to completion, then all four resources are provisioned in order (`sts:GetCallerIdentity` → `s3:CreateBucket` → `s3:PutPublicAccessBlock` → `cloudfront:CreateOriginAccessControl` → `cloudfront:CreateDistribution` → `s3:PutBucketPolicy`) and `infra/token-dashboard/.env` is written with `BUCKET_NAME`, `DIST_ID`, `DIST_DOMAIN`, `OAC_ID` populated and file permissions `0o600`.

**AC-2** — Given `setup.js` is run a second time against an account that already owns the bucket, when `S3Client` throws `BucketAlreadyOwnedByYou` or `BucketAlreadyExists`, then the script prints a clear error message to stderr (e.g., `Bucket already exists: ${WORKSPACE_NAME}-token-dashboard-<id>. Run teardown.js first.`) and exits 1 without provisioning partial resources.

**AC-3** — Given `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are not set and no `~/.aws/credentials` profile is available, when `setup.js` calls `STSClient.send(GetCallerIdentityCommand)`, then it catches the credentials error and prints an actionable message to stderr (e.g., `AWS credentials not found. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or configure AWS_PROFILE.`) and exits 1.

### deploy.js (4 ACs)

**AC-4** — Given `infra/token-dashboard/.env` exists with `BUCKET_NAME` and `DIST_ID`, when `node infra/token-dashboard/deploy.js` runs, then it reads those values from `.env`. Alternatively, given `S3_BUCKET` and `CLOUDFRONT_DIST_ID` are set as environment variables (CI path) and `.env` is absent, when the script runs, then it falls back to the env vars — no `.env` required in CI.

**AC-5** — Given the dashboard HTML file exists at `.claude/visualizations/token-dashboard.html`, when `deploy.js` uploads it, then `PutObjectCommand` is called with `ContentType: 'text/html'` and `CacheControl: 'max-age=300'` (matching `deploy.sh:26-28`).

**AC-6** — Given the upload succeeds, when `deploy.js` creates the CloudFront invalidation, then `CreateInvalidationCommand` is called with `Paths: { Quantity: 1, Items: ['/*'] }` and a unique `CallerReference` (e.g., `Date.now().toString()`), and the invalidation ID is printed to stdout (matching `deploy.sh:37`).

**AC-7** — Given the dashboard HTML file does not exist at the expected path, when `deploy.js` is invoked, then it prints `Error: Dashboard file not found at <path>. Generate it first with: npm run tokens:dashboard` to stderr and exits 1 (matching `deploy.sh:20-23`).

### teardown.js (3 ACs)

**AC-8** — Given `infra/token-dashboard/.env` exists, when `node infra/token-dashboard/teardown.js` is invoked, then it prints the three resource identifiers (`BUCKET_NAME`, `DIST_ID`, `OAC_ID`) and prompts `Continue? (y/N)` via `node:readline`; entering anything other than `y` or `Y` exits 0 with `Aborted.` (matching `teardown.sh:22-28`).

**AC-9** — Given the user confirms with `y`, when `teardown.js` runs, then it executes cleanup in this exact order: (1) `GetDistributionConfig` + `UpdateDistribution` with `Enabled: false`, (2) `waitUntilDistributionDeployed` (max wait 1200 s), (3) `GetDistributionConfig` (fresh ETag) + `DeleteDistribution`, (4) `GetOriginAccessControl` + `DeleteOriginAccessControl`, (5) list all S3 objects + `DeleteObjects` (paginated) + `DeleteBucket`, (6) `fs.unlinkSync('.env')` — matching the sequence in `teardown.sh:30-70`.

**AC-10** — Given `infra/token-dashboard/.env` does not exist, when `teardown.js` is invoked, then it prints `Error: .env not found. Nothing to tear down.` to stderr and exits 1 (matching `teardown.sh:10-13`).

### bitbucket-pipelines.yml (2 ACs)

**AC-11** — Given the updated `bitbucket-pipelines.yml`, when the master deploy step definition is inspected, then the strings `python`, `pip`, and `awscli` do not appear anywhere in that step's `script` array. The test step (PR and master `Test (Linux)` steps) is unchanged.

**AC-12** — Given `npm run tokens:deploy` is called in the deploy step, when it runs, then it invokes `node infra/token-dashboard/deploy.js` and reads `S3_BUCKET` / `CLOUDFRONT_DIST_ID` from the Bitbucket pipeline environment variables (AC-4 CI fallback path). The deploy step has `git` in apt-get install (already present at `bitbucket-pipelines.yml:11`) but no Python tooling.

### package.json (2 ACs)

**AC-13** — `package.json` `dependencies` contains `"@aws-sdk/client-s3": "^3.700.0"` (or the latest `^3.x` at install time), `"@aws-sdk/client-cloudfront": "^3.700.0"`, and `"@aws-sdk/client-sts": "^3.700.0"`. These are in `dependencies`, not `devDependencies`, because they are required at runtime by the deploy step in CI.

**AC-14** — `package.json` `scripts` contains `"tokens:deploy": "node infra/token-dashboard/deploy.js"`. Optionally also `"tokens:setup": "node infra/token-dashboard/setup.js"` and `"tokens:teardown": "node infra/token-dashboard/teardown.js"` for local-dev symmetry (implementer's discretion).

### Orphaned test (3 ACs)

**AC-15** — A new `test(...)` block is appended to `tests/scripts/reconcile-session-attribution.test.js` covering T5 idempotency: write a split-attribution fixture, run `--apply`, capture the file content (or checksum), run `--apply` a second time, assert the file content is byte-identical after the second run.

**AC-16** — A new `test(...)` block is appended to `tests/scripts/reconcile-session-attribution.test.js` covering T7 malformed UUID: inject an event with `session_id: '*-not-a-uuid'` into a fixture events file, run the script, assert `r.status === 0` (or `r.status === 0 || r.status === null`), assert `r.stderr === ''` (no stderr output), and assert `UUID_RE.test('*-not-a-uuid') === false` inline as a sanity check on the gate (cite `scripts/reconcile-session-attribution.js:50`).

**AC-17** — `tests/session-id-attribution.test.sh` is removed via `git rm`; it does not appear in the working tree after the commit.

### Cross-cutting (3 ACs)

**AC-18** — `CLAUDE.md` "Node port complete" line (`CLAUDE.md:139`) reads "Phases 1–8" and includes "AWS infra scripts + orphaned bash test" or equivalent description in the parenthetical.

**AC-19** — The phase reference table in `CLAUDE.md` has a Phase 8 row with scope "AWS infra scripts (`setup.js`, `deploy.js`, `teardown.js`) + orphaned bash test cleanup" and a link to this spec.

**AC-20** — `npm test` exits 0 with no regressions. Infrastructure scripts (`setup.js`, `teardown.js`) are not covered by `npm test` because they require live AWS credentials; `deploy.js` is not tested beyond the missing-file guard (AC-7 is a process-exit test, not an AWS call). Any new test added for AC-15 / AC-16 must not require AWS credentials and must pass in CI without `AWS_ACCESS_KEY_ID` set.

Total: **20 ACs**.

---

## 5. Technical Design

### 5.1 Architecture

Three new files under `infra/token-dashboard/`, one modified pipeline file, two modified JSON files, two modified text files, and one deleted bash test.

No new `_lib/` utilities. The AWS SDK v3 clients handle credential resolution natively via the default provider chain (`AWS_ACCESS_KEY_ID` → `~/.aws/credentials` → instance profile); no explicit credential loading is needed.

### 5.2 deploy.js scaffold

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '.env');
const DEFAULT_DASHBOARD = path.join(
  __dirname, '..', '..', '.claude', 'visualizations', 'token-dashboard.html'
);

function loadEnv() {
  if (process.env.S3_BUCKET && process.env.CLOUDFRONT_DIST_ID) {
    return { bucketName: process.env.S3_BUCKET, distId: process.env.CLOUDFRONT_DIST_ID };
  }
  if (!fs.existsSync(ENV_FILE)) {
    process.stderr.write('Error: .env not found. Run setup.js first (or set S3_BUCKET + CLOUDFRONT_DIST_ID).\n');
    process.exit(1);
  }
  const vars = {};
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k) vars[k.trim()] = rest.join('=').trim();
  });
  return { bucketName: vars.BUCKET_NAME, distId: vars.DIST_ID };
}

async function main() {
  const dashboardFile = process.argv[2] || DEFAULT_DASHBOARD;
  if (!fs.existsSync(dashboardFile)) {
    process.stderr.write(`Error: Dashboard file not found at ${dashboardFile}\nGenerate it first with: npm run tokens:dashboard\n`);
    process.exit(1);
  }
  const { bucketName, distId } = loadEnv();
  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });
  const cf = new CloudFrontClient({ region });

  console.log(`==> Uploading dashboard to s3://${bucketName}/`);
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: 'index.html',
    Body: fs.readFileSync(dashboardFile),
    ContentType: 'text/html',
    CacheControl: 'max-age=300',
  }));

  console.log('==> Invalidating CloudFront cache');
  const inv = await cf.send(new CreateInvalidationCommand({
    DistributionId: distId,
    InvalidationBatch: {
      CallerReference: Date.now().toString(),
      Paths: { Quantity: 1, Items: ['/*'] },
    },
  }));
  console.log(`    Invalidation: ${inv.Invalidation.Id}`);
  console.log('==> Deploy complete!');
}

main().catch(err => { process.stderr.write(err.message + '\n'); process.exit(1); });
```

### 5.3 setup.js scaffold (key sections)

Use `@aws-sdk/client-sts` (`GetCallerIdentityCommand`) to resolve `AWS_ACCOUNT_ID`. Then call:

| SDK Command | Replaces |
|---|---|
| `S3Client` / `CreateBucketCommand` | AWS CLI `s3api create-bucket` (`setup.sh:15-17`) |
| `PutPublicAccessBlockCommand` | AWS CLI `s3api put-public-access-block` (`setup.sh:19-22`) |
| `CloudFrontClient` / `CreateOriginAccessControlCommand` | AWS CLI `cloudfront create-origin-access-control` (`setup.sh:25-29`) |
| `CreateDistributionCommand` | AWS CLI `cloudfront create-distribution` (`setup.sh:83-86`) |
| `PutBucketPolicyCommand` | AWS CLI `s3api put-bucket-policy` (`setup.sh:118-120`) |

Parse `DIST_ID` and `DIST_DOMAIN` from the JS response object (`result.Distribution.Id`, `result.Distribution.DomainName`) — no Python heredoc needed (`setup.sh:88-89`).

Write `.env` via:

```js
fs.writeFileSync(ENV_FILE,
  `BUCKET_NAME=${bucketName}\nDIST_ID=${distId}\nDIST_DOMAIN=${distDomain}\nOAC_ID=${oacId}\n`,
  { mode: 0o600 }
);
```

Idempotency (AC-2): catch errors where `Code === 'BucketAlreadyOwnedByYou'` or `Code === 'BucketAlreadyExists'` and exit 1 with a clear message before proceeding to CloudFront provisioning.

The distribution config object mirrors `setup.sh:34-81` exactly — same `CachePolicyId`, `PriceClass`, `CustomErrorResponses`, `OriginAccessControlId` wiring.

Note: `@aws-sdk/client-sts` is a third dependency. Add it to `dependencies` alongside `client-s3` and `client-cloudfront`.

### 5.4 teardown.js scaffold (key sections)

```js
const readline = require('node:readline');
const { CloudFrontClient,
  GetDistributionConfigCommand, UpdateDistributionCommand,
  DeleteDistributionCommand,
  GetOriginAccessControlCommand, DeleteOriginAccessControlCommand,
  waitUntilDistributionDeployed } = require('@aws-sdk/client-cloudfront');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
```

Interactive confirmation via `node:readline` (same pattern as `scripts/setup.js` from Phase 7):

```js
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Continue? (y/N) ', answer => {
  rl.close();
  if (!/^[Yy]$/.test(answer.trim())) { console.log('Aborted.'); process.exit(0); }
  runTeardown().catch(err => { process.stderr.write(err.message + '\n'); process.exit(1); });
});
```

`waitUntilDistributionDeployed` override (R-4):

```js
await waitUntilDistributionDeployed(
  { client: cf, maxWaitTime: 1200 },
  { Id: distId }
);
```

ETag dance for disable + delete: call `GetDistributionConfig`, set `DistributionConfig.Enabled = false`, call `UpdateDistribution` with the original ETag; then after wait, call `GetDistributionConfig` again for a fresh ETag before `DeleteDistribution`. This matches `teardown.sh:31-55`.

S3 empty: paginate `ListObjectsV2Command` and batch-delete with `DeleteObjectsCommand`. AWS CLI `s3 rm --recursive` (`teardown.sh:67`) does the same under the hood.

### 5.5 bitbucket-pipelines.yml deploy step (after)

```yaml
- step:
    name: Deploy Token Dashboard
    script:
      - apt-get update && apt-get install -y git --no-install-recommends
      - npm ci || npm install
      - npm run tokens:dashboard
      - npm run tokens:deploy
```

`S3_BUCKET` and `CLOUDFRONT_DIST_ID` remain as Bitbucket pipeline repository variables (unchanged). No `python3 pip awscli` lines.

### 5.6 package.json additions

```json
"dependencies": {
  "@aws-sdk/client-cloudfront": "^3.700.0",
  "@aws-sdk/client-s3": "^3.700.0",
  "@aws-sdk/client-sts": "^3.700.0",
  "@azure/cosmos": "^4.9.0",
  "chalk": "^4.1.2"
},
"scripts": {
  ...
  "tokens:deploy":    "node infra/token-dashboard/deploy.js",
  "tokens:setup":     "node infra/token-dashboard/setup.js",
  "tokens:teardown":  "node infra/token-dashboard/teardown.js",
  ...
}
```

Version pins: use `^3.700.0` as a concrete floor; implementer should run `npm install @aws-sdk/client-s3@latest` to resolve the actual latest `^3.x` at install time.

### 5.7 T5 / T7 test additions (AC-15, AC-16)

Extend `tests/scripts/reconcile-session-attribution.test.js` with two new `test(...)` blocks after the existing AC-24 block. Reuse the existing `run()`, `tmpDir()`, `writeJsonl()`, and `writeTranscript()` helpers — no new helpers needed.

**T5 fixture**: same split-attribution setup as AC-22 (two events with different `jira_ticket` values for the same `session_id`). Run `--apply` once, read the events file content into `before`. Run `--apply` again. Read the events file content into `after`. Assert `before === after`.

**T7 fixture**: a single-event events file with `session_id: '*-not-a-uuid'`. Run the script in audit mode (no args). Assert `r.status === 0` and `r.stderr === ''`. Also assert inline:

```js
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.equal(UUID_RE.test('*-not-a-uuid'), false);
```

This is a direct citation of `scripts/reconcile-session-attribution.js:50`.

### 5.8 AWS region and credential handling

- `AWS_REGION` env (default `us-east-1`) passed to all SDK clients.
- `AWS_PROFILE` is respected natively by the default credential provider chain — no explicit `fromIni()` import needed. Local-dev with `AWS_PROFILE=<profile>` works without code changes.
- Bitbucket pipeline provides `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` as repository variables. The SDK picks these up automatically.

### 5.9 No bash stubs for infra scripts

The Phase 1–7 convention (every ported script gets a 2-line bash stub + `.cmd` sibling) does NOT apply here. Rationale:

1. `deploy.js` is invoked exclusively via `npm run tokens:deploy` in CI and local-dev — never as a bare shell command.
2. `setup.js` and `teardown.js` are one-time human invocations; developers run `node infra/token-dashboard/setup.js` directly.
3. No prior bash entry point existed with the same bare name (e.g., there is no `infra/token-dashboard/setup` without extension that callers depend on).
4. Adding stubs would create three files that provide zero value and violate "no speculative abstractions."

---

## 6. Cost & Performance

**Pipeline wall-clock**: the `apt-get install python3 pip` + `pip install awscli` sequence takes approximately 18–22 s on `node:20-slim` (dominated by the pip download). Eliminating it reduces the master deploy step from ~35 s to ~15 s.

**Image size**: no Python runtime → the Docker layer cache for the deploy step shrinks by ~80 MB (pip + awscli installed globally). The three `@aws-sdk` packages add approximately 600 KB to `node_modules` (200 KB each, uncompressed source). Net reduction: ~79 MB on the runner image cache.

**`npm ci` overhead**: `@aws-sdk` v3 packages are modular and tree-shakeable. `npm ci` cold-install adds ~2 s. The node_modules cache in Bitbucket Pipelines covers this on subsequent runs.

---

## 7. Implementation Notes

**Recommended porting order** (each step is independently mergeable):

1. `deploy.js` — smallest, highest-value, unblocks pipeline clean-up immediately.
2. `package.json` + `bitbucket-pipelines.yml` — wire `tokens:deploy`; update deploy step.
3. `setup.js` — exercised manually by developers; no CI dependency.
4. `teardown.js` — rarely run; port last.
5. T5 + T7 test additions + `git rm tests/session-id-attribution.test.sh`.
6. `CLAUDE.md` update.

**ETag concurrency**: AWS CloudFront `delete-distribution` requires the ETag from the most recent `get-distribution-config` call. Between the `update-distribution` (disable) call and `delete-distribution`, the ETag changes once the distribution finishes deploying. Always call `GetDistributionConfig` again after `waitUntilDistributionDeployed` to get the post-deploy ETag before calling `DeleteDistribution`. The bash `teardown.sh:49-51` does this correctly.

**Python heredoc replacement in setup.js**: `setup.sh:88-89` parses `aws cloudfront create-distribution --output json` via Python. In JS, the SDK response is already a parsed object — `result.Distribution.Id` and `result.Distribution.DomainName` are direct property accesses. No parsing step needed.

**Python heredoc replacement in teardown.js**: `teardown.sh:38` mutates `Enabled=False` on the distribution config via Python. In JS, `GetDistributionConfigCommand` returns a JS object; set `response.DistributionConfig.Enabled = false` and pass the modified config to `UpdateDistributionCommand`. No `JSON.parse` needed.

**`.env` parsing in deploy.js**: use a simple `key=value` line split (no external parser needed). Handles the four keys written by `setup.js`. Do not use `dotenv` — no new dependencies beyond the three AWS SDK packages.

**T5 idempotency implementation note**: the reconcile script creates a `.bak.<timestamp>` file on `--apply`. On the second `--apply`, if all events already have `attribution_review_needed: true`, the script finds nothing to annotate and should exit 0 without rewriting the file. Verify this behavior in `scripts/reconcile-session-attribution.js` before writing the test — if the script always rewrites, the assertion is that the content is identical, not that no `.bak` was created.

**T7 note on bash original**: the bash test runs `reconcile-session-attribution.sh` twice — once discarding stdout, once asserting empty stderr. The Node test only needs one `run()` call; assert `r.stderr === ''` directly.

**`npm test` isolation**: the two new test blocks use `EVENTS_FILE_OVERRIDE` and `CC_PROJECTS_OVERRIDE` env vars for fixtures, matching the pattern in AC-21..AC-24. They do not touch live `.ai-memory/` data. No `AWS_*` env vars are needed.

---

## 8. Risks & Open Questions

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R-1 | `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`, `@aws-sdk/client-sts` add ~600 KB to `node_modules`. The eliminated `python3 + awscli` install is ~80 MB on the runner image. Net win overwhelms the risk. | Low | Accept. Document in §6. |
| R-2 | AWS SDK v3 major version churn — a v4 release could break `^3.x` pins. | Very Low | Pin `^3` (semver-compatible minor/patch updates only). Upgrade to v4 as a separate PR when GA. |
| R-3 | Bitbucket pipeline must have `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, and `CLOUDFRONT_DIST_ID` as repository variables. Misconfigured vars cause `deploy.js` to throw credentials or "bucket not found" errors at runtime. | Low | Already set for the bash step. Verify they exist before merging. Document in the PR description. |
| R-4 | `waitUntilDistributionDeployed` default timeout is 3600 s; CloudFront disables can take 10–15 min. Override to 1200 s (`maxWaitTime: 1200`) to fail fast on stuck distributions. | Medium | Explicit override in `teardown.js` scaffold (§5.4). Acceptable tradeoff: if disable takes > 20 min something is broken and manual intervention is warranted. |
| R-5 | `ContentType: 'text/html'` vs `'text/html; charset=utf-8'` — the SDK may append a charset. The bash `deploy.sh:27` passes `text/html` (no charset). | Low | Explicitly set `ContentType: 'text/html'` in `PutObjectCommand`. The SDK does not append charset unless you add it. AC-5 documents the expected exact value. |
| R-6 | T5 idempotency: if `scripts/reconcile-session-attribution.js` always rewrites the events file on `--apply` (even when nothing changed), the byte-identity assertion will fail. | Medium | Read the apply path in `scripts/reconcile-session-attribution.js` before writing the test. If it always rewrites, assert content equality (not file-object identity). |
| R-7 | T6 in the bash test (audit on the reconciled file, `tests/session-id-attribution.test.sh:177-181`) is not ported by this phase. It is already covered implicitly by AC-22 in `tests/scripts/reconcile-session-attribution.test.js` (the `--apply` run produces annotations; a subsequent audit-mode run would see `attribution_review_needed` events). Document this in the PR if reviewers ask. |

---

## 9. File Map

**New files (3)**:

| File | Description |
|---|---|
| `infra/token-dashboard/setup.js` | Port of `setup.sh`; provisions S3 + CloudFront OAC + distribution + bucket policy; writes `.env` |
| `infra/token-dashboard/deploy.js` | Port of `deploy.sh`; uploads HTML to S3, creates CloudFront invalidation; reads `.env` or env vars |
| `infra/token-dashboard/teardown.js` | Port of `teardown.sh`; interactive y/N, disables+waits+deletes distribution, OAC, bucket; removes `.env` |

**Modified files (5)**:

| File | Change |
|---|---|
| `package.json` | Add `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`, `@aws-sdk/client-sts` to `dependencies`; add `tokens:deploy`, `tokens:setup`, `tokens:teardown` scripts |
| `bitbucket-pipelines.yml` | Replace lines 27-31 (`python3 pip awscli` + raw AWS CLI calls) with `npm ci \|\| npm install` + `npm run tokens:deploy` |
| `tests/scripts/reconcile-session-attribution.test.js` | Append T5 (idempotency) and T7 (malformed UUID) test blocks after existing AC-24 |
| `CLAUDE.md` | "Node port complete" line: "Phases 1–7" → "Phases 1–8"; add Phase 8 row to phase reference table |
| `infra/token-dashboard/.env` | Not committed (gitignored); schema unchanged: `BUCKET_NAME`, `DIST_ID`, `DIST_DOMAIN`, `OAC_ID` |

**Deleted files (1)**:

| File | Method |
|---|---|
| `tests/session-id-attribution.test.sh` | `git rm` |

Total files touched: **9** (3 new, 5 modified, 1 deleted).

---

## 10. Grounding Citations

**Problem Statement**:

- `bitbucket-pipelines.yml:27-31` — Python/pip/awscli install + raw AWS CLI deploy commands (current state).
- `infra/token-dashboard/setup.sh:88-89` — Python heredoc one-liners for JSON parsing (`DIST_ID`, `DIST_DOMAIN`).
- `infra/token-dashboard/teardown.sh:38` — Python heredoc for `json.loads` + set `Enabled=False` + `json.dumps`.
- `tests/session-id-attribution.test.sh:1-28` — header comment enumerating T1–T8 and marking the file as not wired into `npm test` or CI.
- `tests/session-id-attribution.test.sh:169-175` — T5 body (sha256sum before/after second `--apply`).
- `tests/session-id-attribution.test.sh:183-198` — T7 body (inject `*-not-a-uuid` event, assert empty stderr).
- `CLAUDE.md:139` — current "Node port complete" claim citing Phases 1–7.
- Phase 7 Non-Goal: `docs/specs/spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md` §3.

**Technical Design**:

- `infra/token-dashboard/setup.sh:11` — `aws sts get-caller-identity --query Account --output text`
- `infra/token-dashboard/setup.sh:15-17` — AWS CLI `s3api create-bucket`
- `infra/token-dashboard/setup.sh:19-22` — AWS CLI `s3api put-public-access-block`
- `infra/token-dashboard/setup.sh:25-29` — AWS CLI `cloudfront create-origin-access-control`
- `infra/token-dashboard/setup.sh:34-81` — CloudFront distribution config JSON (price class, cache policy, custom errors)
- `infra/token-dashboard/setup.sh:83-86` — AWS CLI `cloudfront create-distribution --output json`
- `infra/token-dashboard/setup.sh:88-89` — Python heredoc replaced by `result.Distribution.Id` / `result.Distribution.DomainName`
- `infra/token-dashboard/setup.sh:118-120` — AWS CLI `s3api put-bucket-policy`
- `infra/token-dashboard/setup.sh:131-136` — `.env` write (4 keys)
- `infra/token-dashboard/deploy.sh:10-13` — `.env` existence check
- `infra/token-dashboard/deploy.sh:17` — optional positional arg for dashboard file path
- `infra/token-dashboard/deploy.sh:19-23` — dashboard file existence check + hint
- `infra/token-dashboard/deploy.sh:26-28` — AWS CLI `s3 cp` with `text/html` and `max-age=300`
- `infra/token-dashboard/deploy.sh:31-36` — AWS CLI `cloudfront create-invalidation` + extract invalidation ID
- `infra/token-dashboard/teardown.sh:10-13` — `.env` existence check
- `infra/token-dashboard/teardown.sh:22-28` — `read -p` y/N confirmation
- `infra/token-dashboard/teardown.sh:31-55` — ETag dance: get → disable → wait → get-fresh-ETag → delete distribution
- `infra/token-dashboard/teardown.sh:57-64` — OAC ETag → delete OAC
- `infra/token-dashboard/teardown.sh:66-68` — `s3 rm --recursive` + `delete-bucket`
- `infra/token-dashboard/teardown.sh:38` — Python heredoc for mutating `Enabled=False` in distribution config
- `infra/token-dashboard/iam-policy.json:7-9` — deploy user can only call `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `cloudfront:CreateInvalidation` — confirms `deploy.js` needs only `PutObjectCommand` and `CreateInvalidationCommand`
- `scripts/reconcile-session-attribution.js:50` — `UUID_RE` definition
- `scripts/reconcile-session-attribution.js:73` — `if (!UUID_RE.test(sid)) return null` gate (T7 assertion target)
- `tests/scripts/reconcile-session-attribution.test.js:1-191` — existing AC-21..AC-24 pattern (tempdir fixture, `run()`, `writeJsonl()`, `writeTranscript()`)
- `package.json:5-8` — current `dependencies` (only `@azure/cosmos`, `chalk`); confirms `@aws-sdk/*` is a new addition
