# Skill Deployment Playbook

How to take a workspace skill from "runs when I invoke it in Claude Code" to "runs unattended on a
schedule." This is the **skill-agnostic** guide — the reusable decision framework, patterns, and gotchas
distilled from deploying a real scheduled reporting skill across local cron, Bitbucket Pipelines, and
Anthropic Managed Agents.

Worked-example references below use a hypothetical `team-digest` skill — a scheduled job that computes
delivery metrics and posts a digest to Slack. Substitute your own skill's scripts.

## Step 0 — Deterministic or agentic?

This one question decides everything downstream. Split the skill's work in two:

- **Deterministic core** — data fetch + computation + output that can be pure code (Node/Python), no LLM.
  If you can express it as `node do-the-thing.js`, it belongs here.
- **Agentic layer** — anything needing model judgment: natural-language triggering, ad-hoc phrasing,
  interpretation, "figure out how" steps.

Push as much as possible into the deterministic core. A deterministic core is cheaper (no tokens), faster,
reproducible (same input → identical output), and deployable to the most reliable homes. Reserve the agentic
layer for what genuinely needs a model. A well-factored reporting skill is ~95% deterministic (one `build_digest.js` computes every number,
including rule-based insights); only ad-hoc chat triggering needs the model.

## The three deployment homes

| Home | Runs | Laptop-independent | Cost | Best for |
|---|---|---|---|---|
| **Local launchd / cron** | your machine | ❌ | free | dev iteration, personal one-offs |
| **Bitbucket Pipelines** | Bitbucket CI cloud | ✅ | free (no LLM) | deterministic scheduled jobs — native repo checkout |
| **Managed Agents deployment** | Anthropic cloud | ✅ | LLM tokens | agentic scheduled jobs — real timezone, no repo wrinkle |

Pick by Step 0: **deterministic → Bitbucket** (free, native repo, rock-solid); **agentic → Managed Agents**
(cloud, laptop-independent). Local cron is for development only — never a production home for a team report.

> **Do not double-schedule the same tier in two homes** — it double-posts. Pick one scheduler per tier; if
> you move a skill from Bitbucket to Managed Agents, comment out / pause the old one in the same change.

## Cross-cutting requirements

These apply regardless of home. Get them right once and any home works.

### Secrets

- **In code:** read via a resolver that prefers the environment, falling back to `.env` for local dev — the
  `scripts/_lib/` / `_env.js` `getSecret()` pattern. This lets the same script run unchanged locally and in CI.
- **Bitbucket:** set secrets as **SECURED repository variables** (Settings → Repository variables). They
  arrive as env vars.
- **Managed Agents:** store secrets in a **vault** as `environment_variable` credentials, each **egress-scoped**
  to the hosts that need it (`networking.allowed_hosts`). The sandbox only ever sees an opaque placeholder;
  the real value is substituted at egress.
  - ‼️ **Never transform a vault placeholder** — base64, URL-encode, string-slice, etc. Egress substitution
    looks for the exact placeholder in the outbound bytes, so `curl -u "$USER:$TOKEN"` works (the SDK encodes
    after substitution) but manually base64-ing the credential yourself breaks it. Use secrets verbatim.
- **Never** put a secret in a system prompt, user message, or committed file.

### State (trend/history/recommendations)

- **Externalize mutable state** off the local filesystem — a scheduled cloud run has no persistent disk.
- **Append-only logs** (`*.jsonl`): commit them back to git and register a **union merge driver** so
  concurrent runs on different machines combine instead of conflicting:

  ```gitattributes
  .ai-memory/my-skill-history.jsonl merge=union
  ```

  Single-object JSON state (rewritten each run) can't use union merge — keep it small and single-writer, or
  refactor to `.jsonl`.
- **Commit-back pattern:** the run does its work, `git add` **only its own state files**, commits, and the
  runner pushes (pull → run → push). Never `git add -A` from an automated job.
- **Cloud alternative:** point state at S3/DynamoDB instead of git if you want to drop the repo dependency.

### Fail loud, not silent

A scheduled job with missing creds or a dead upstream must **fail visibly**, not post zeros. Add a guard that
detects a degraded run (no data from the primary sources) and **exits non-zero without posting or committing**.
A red schedule then means "fix the creds," not "silently published garbage." (example: an `isDegraded()` helper in
`build_digest.js`.)

### Preview / idempotency gotchas

If a build step appends to a history file *before* the post/commit gate, a preview run pollutes the trend and
the real run diffs against a duplicate. Either pop the preview row before the committed run, or run once and
preview the returned text. Keep generated artifacts (HTML dashboards, data dumps) **gitignored** so they're
never auto-committed.

## Scheduling to an exact local hour (the DST trap)

- **Managed Agents** cron takes a real IANA `timezone` with wall-clock DST matching — `"0 6 * * 1-5"` +
  `America/New_York` is 6am ET year-round. No hack. (Avoid the 1–3am window: spring-forward skips it,
  fall-back doubles it.)
- **Bitbucket / OS cron are UTC-only.** A fixed UTC time drifts 1h across DST. To hit an exact local hour,
  schedule **two** crons (e.g. `0 10` and `0 11` UTC for 6am ET) and gate the step with a helper that exits 0
  unless the current local hour matches, so only the right firing runs. (example: an `at-local-hour.js` guard.)

## Managed Agents specifics

- **Flow:** create the Agent + Environment + Vault **once** (persistent, versioned), then create Deployments
  (one per schedule). Never create the agent per run.
- **Repo access is GitHub-native.** The `github_repository` session resource only clones GitHub. For a
  **Bitbucket** repo, the agent clones over HTTPS with the Atlassian API token using the git username
  **`x-bitbucket-api-token-auth`** — i.e. `https://x-bitbucket-api-token-auth:$ATLASSIAN_API_TOKEN@bitbucket.org/...`.
  (`x-token-auth` is for Bitbucket *access tokens*, not Atlassian API tokens, and fails; `email:token` basic
  fails for git even though it works for the REST API.) The same token clones and pushes if it has
  `write:repository` scope — no separate token needed.
- **Pin fragile steps in the system prompt.** A scheduled agent should not *explore*. Give it the one exact
  command for anything finicky (repo fetch, auth) and tell it not to improvise — otherwise it burns the whole
  session budget trying alternatives. This was the single difference between a timed-out run and a clean one.
- **Manage:** `deployments.pause/unpause/archive`, audit fires via `deployment_runs.list({deployment_id, has_error: true})`.
  Watch live in the Console: `https://platform.claude.com/workspaces/default/sessions`.

## New-skill deployment checklist

1. **Split** the skill into a deterministic core (`node …`) and an agentic layer. Maximize the core.
2. **Secrets** read via `getSecret()` (env → `.env`). List every secret and the hosts it talks to.
3. **State** externalized: append-only `.jsonl` + `merge=union` in `.gitattributes`, committed back; artifacts gitignored.
4. **Fail-safe** guard: degraded run → non-zero exit, no post/commit.
5. **Pick one home** per tier (Step 0): deterministic → Bitbucket; agentic → Managed Agents. Don't double-schedule.
6. **Schedule** at the right local hour (real TZ on MA; two-cron + hour-gate on UTC schedulers).
7. **Validate** with a manual run to a **test** channel/target before enabling the cron and pointing at prod.
8. **Document** the deploy in the skill's own `deploy/` handoff (secrets, entrypoints, schedule, state).
