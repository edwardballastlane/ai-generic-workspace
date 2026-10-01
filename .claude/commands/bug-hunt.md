# Bug Hunt — Autonomous Datadog Error Analysis

You are running the **Reliability Loop** — fetching and analyzing Datadog errors to find root causes and create fixes.

**Arguments:** $ARGUMENTS

## Step 1: Fetch Errors

Run the bug hunter script to fetch errors from Datadog:

```bash
# Default: last 24h
./scripts/dd-bug-hunter --list

# Or with arguments from the user
./scripts/dd-bug-hunter $ARGUMENTS
```

If `$ARGUMENTS` contains a trace ID, use `--trace <ID>`.
If it contains a service name, use `--service <name>`.
If it contains a number, use `--hours <number>`.

## Step 2: Analyze

Read the error data from `.ai-session/bug-hunter/`.

For each high-priority error (count > 10 or severity critical):
1. Identify the failing service from the projects in this workspace
2. Find the project in `agent/_projects/`
3. Use the `reliability-hunter` agent type to spawn a subagent for root cause analysis

## Step 3: Agent Team (for multiple errors)

If there are 3+ high-priority errors, create an agent team for parallel analysis:

```
Create an agent team to analyze these Datadog errors in parallel.

Error data: .ai-session/bug-hunter/

For each error, spawn a reliability-hunter teammate:
- Teammate 1: Analyze error pattern "[most frequent error]" in [service]
- Teammate 2: Analyze error pattern "[second error]" in [service]
- Teammate 3: Analyze error pattern "[third error]" in [service]

Each teammate should:
1. Read the error data
2. Find the root cause in the codebase
3. Create a hotfix branch
4. Open a DRAFT PR

Wait for all teammates to complete, then synthesize findings.
```

## Step 4: Report

Produce a summary report for the team's dev Slack channel:

```
## Daily Bug Hunter Report — [date]

Errors analyzed: N
Fixes created: M draft PRs

| Severity | Error | Service | Root Cause | Fix |
|----------|-------|---------|------------|-----|
| Critical | [msg] | [svc] | [cause] | PR #123 (draft) |
| High | [msg] | [svc] | [cause] | PR #124 (draft) |

### Action Required
- [ ] Review PR #123 — [description]
- [ ] Review PR #124 — [description]
```

## If Datadog is not configured

If `DD_API_KEY` or `DD_APP_KEY` are not set:

```
Datadog is not configured. To set up:

1. Get your API key from https://app.datadoghq.com/organization-settings/api-keys
2. Get your App key from https://app.datadoghq.com/organization-settings/application-keys
3. Add to .env:
   DD_API_KEY=your-api-key
   DD_APP_KEY=your-app-key

Or set them in your shell:
   export DD_API_KEY=your-api-key
   export DD_APP_KEY=your-app-key
```
