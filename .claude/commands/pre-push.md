# Pre-Push: Code Review & Push

You MUST follow these steps in order. Do NOT skip any step.

## Step 1 — Gather context

Run these in parallel:
- `git branch --show-current` (get branch name)
- `git diff origin/$(git branch --show-current)..HEAD` (diff to push — if fails, use `git log -p origin..HEAD`)
- `git diff --cached` + `git diff` (any uncommitted changes)

Also detect the project name from `.ai-session/current.yaml` or the git remote.

## Step 1.5 — Learning-health check (non-blocking)

Run:
```bash
node scripts/_lib/learning-health.js --check
```

Print its output verbatim. This reports whether embedded sessions have been turned into rules, and auto-triggers a background extraction if the pipeline is stale (cooldown-gated). **It never blocks the push** — it is informational. If it reports Qdrant is down, just note it and continue.

## Step 2 — Read review inputs

Read ALL of these files:
- `.ai-memory/lessons/global.yaml`
- `.ai-memory/lessons/<project>.yaml`
- `.ai-contexts/<project>.yaml` — look for the `review:` section with `focus:` items
- The project's `.github/pull_request_template.md` (from the actual repo being pushed)

## Step 3 — Spawn reviewer agent

Use the **Agent tool** (subagent_type: `general-purpose`) to spawn a reviewer. Pass it:

1. The full diff from Step 1
2. The full lessons content from Step 2
3. The PR template content from Step 2
4. The project's `review.focus` items from `.ai-contexts/<project>.yaml`
5. These instructions:

```
You are a senior code reviewer simulating the human reviewer who will see this PR. Your job is to catch issues BEFORE the PR is created, so the human reviewer finds nothing to complain about.

## Review in this order of priority:

### 1. LESSONS CHECK (blocking)
For each lesson in global.yaml and <project>.yaml, check if the diff violates it.
Focus on: Sonar rules, security (token leaks, hardcoded secrets, header sanitization), architecture (hydration, SSR, React 19), git conventions.

### 2. PROJECT-SPECIFIC CHECK (blocking)
For each item in the project's review.focus list, check if the diff violates it.
These are the project's specific review standards — treat each focus item as a rule that MUST be followed.

### 3. CODE QUALITY CHECK (blocking)
- Readable, self-documenting code
- Functions small and focused
- No code duplication introduced
- Consistent naming conventions
- Appropriate error handling
- Non-obvious code has WHY comments

### 4. SECURITY CHECK (blocking)
- Input validation at system boundaries
- No hardcoded secrets or credentials
- No sensitive data in logs (tokens, passwords, PII)
- XSS/injection prevention where applicable
- Auth/authz correctness

### 5. CONSISTENCY CHECK (blocking)
- New code follows existing patterns in the codebase (the diff should show enough context)
- Missing UpdateAsync/SaveChanges calls after mutations
- Missing TrackEntity for backing field collections
- Cookie settings consistent across all set-points
- Error handling matches surrounding code style

### 6. COMPLETENESS CHECK (warning)
Based on the PR template checklist, flag if any of these seem missing:
- Tests for the changes (unit or integration)
- Auto-generated files accidentally committed (next-env.d.ts, lockfile churn)
- Unrelated changes mixed in

### 7. PERFORMANCE CHECK (warning)
- No obvious N+1 queries
- No unnecessary SSR/hydration work
- No blocking operations in hot paths

## Output format:

For each issue found, report:
- **Category**: Lesson/ProjectReview/CodeQuality/Security/Consistency/Completeness/Performance
- **Severity**: Error (must fix) | Warning (should fix) | Suggestion
- **File:Line**: Location
- **Issue**: What's wrong
- **Fix**: How to fix it

If NO issues found at all, respond with exactly: "CLEAN: No issues detected."

Be strict on Errors. Be practical on Warnings — only flag real problems, not style preferences.
```

## Step 4 — Act on results

**If agent returns "CLEAN":**
- Print: "Review passed. Pushing..."
- Run `git push` using the bypass command below
- Confirm success

**If agent returns only Warnings/Suggestions (no Errors):**
- Print the warnings clearly
- Ask the user: "No blocking issues. Push anyway? (y/n)"
- If yes, push. If no, stop.

**If agent returns any Errors:**
- Print ALL issues (errors + warnings)
- **DO NOT push**
- Tell the user what to fix

## Hook bypass

The pre-tool-use hook blocks raw `git push`. When YOU (the /pre-push skill) need to push after review passes, use this exact command which the hook will allow:

```bash
git push # pre-push-reviewed
```

The hook checks for the `# pre-push-reviewed` comment to allow the push through.
