# Verify — Runtime Observation + Ticket Comment

**Verification is runtime observation.** Build the app, run it, drive it to where the changed code executes, capture what you see. That capture is your evidence. Nothing else is.

**Don't run tests. Don't typecheck.** They prove CI works, not that the feature works. Don't `import-and-call` internal functions — that's a unit test you wrote. Find the CLI, socket, or window and go there.

---

## 1. Find the change

```bash
git log --oneline @{u}..              # commits ahead of upstream
git diff @{u}.. --stat                # full range stat
git diff origin/HEAD... --stat        # no upstream: vs base
git diff HEAD --stat                  # uncommitted
```

State the commit count. Large diff? Redirect to a file then Read it. **The diff is ground truth — any description is a claim about it.**

---

## 2. Identify the surface

| Change reaches | Surface | You |
|---|---|---|
| CLI / TUI | terminal | type the command, capture the pane |
| Server / API | socket | send the request, capture the response |
| GUI | pixels | drive it with Playwright, screenshot |
| Library | package boundary | sample code through the public export |
| Prompt / agent config | the agent | run it, capture behavior |

Internal function → not a surface. Follow the call chain to a surface above.

**No runtime surface** (docs-only, type declarations, build config with no behavioral diff) → report **SKIP — no runtime surface: (reason).** Don't run tests to fill the space.

---

## 3. Get a handle

Check `.claude/skills/` first — a matching `verifier-*` skill is the repo's evidence-capture protocol:

```bash
ls .claude/skills/
```

- Matching `verifier-*` → invoke it and follow it verbatim.
- `run-*` but no verifier → use its build/launch primitives.
- Neither → cold start from README/package.json/Makefile. Timebox ~15 min. Stuck → BLOCKED with exactly where it stopped.

---

## 4. Drive it

Smallest path that makes the changed code execute. Changed a handler? Hit that route. Changed error handling? Trigger the error.

**Read your plan back before running.** If every step is build/typecheck/run tests — you've planned a CI rerun, not a verification.

---

## 5. Push on it (probes)

The claim checked out — that's the first half. Probe *around* it:

- New flag/option → empty value, typo, conflicting flag
- New handler → wrong method, malformed body, missing field
- Changed error path → adjacent errors it didn't touch
- Interactive/TUI → Ctrl-C mid-op, rapid-fire, Esc at wrong moment
- State/persistence → do it twice, stale state, two sessions

At least one 🔍 probe per report. A Steps list with all ✅ and no 🔍 is a happy-path replay.

---

## 6. Capture

Stdout, response bodies, screenshots, pane dumps. Captured output is evidence; your memory isn't.

---

## 7. Report

```
## Verification: <one-line what changed>

**Verdict:** PASS | FAIL | BLOCKED | SKIP

**Claim:** <what it's supposed to do — your read of the diff; note any mismatch>

**Method:** <how you got a handle; what you launched>

### Steps

1. ✅/❌/⚠️/🔍 <what you did to the running app> → <what you observed>
   <evidence: pane capture, response body, screenshot>

### Findings
<Things you noticed — friction, surprises, anything a first-time user would trip on.
Lead with ⚠️ for lines worth interrupting the reviewer for.
Each probe gets a line even when it held.>
```

**Verdicts:**
- **PASS** — ran the app, the change did what it should at its surface.
- **FAIL** — ran it and it doesn't. Or it breaks something else. Or claim and diff disagree.
- **BLOCKED** — couldn't reach a state where the change is observable.
- **SKIP** — no runtime surface exists.

No partial pass. Ambiguous output → FAIL with raw capture attached.

---

## 8. Offer to post to Jira (MANDATORY final step)

After outputting the report, **always ask**:

> Would you like me to add this verification report as a comment on the Jira ticket?

- If the user says yes (or there is an active Jira ticket in the session): use `addCommentToJiraIssue` with your site's `cloudId` to post the report as a markdown comment. Format it cleanly — include verdict, steps summary, and findings.
- Check the session file for the linked ticket: `grep jira_ticket .ai-session/current.yaml`
- If no ticket is found, ask the user for the key before posting.
- If the user says no, skip silently.
