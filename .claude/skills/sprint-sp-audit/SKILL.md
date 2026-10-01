---
name: sprint-sp-audit
description: >
  Audit the current Jira sprint for tickets that are missing story points, prioritizing the ones
  already Done, and match each to the local AI session-effort data in this workspace to recommend a
  point value. Use this skill whenever the user says "check my jira tickets for story points", "which
  sprint tickets are missing story points", "find unpointed tickets", "what's missing story points
  this sprint", "story-point my done tickets", "audit the sprint for missing points", or asks to
  reconcile/backfill story points using local session data. Trigger it even when the user phrases it
  loosely (e.g. "which of my tickets don't have estimates") as long as the intent is finding sprint
  tickets without story points. This is the per-developer SP-backfill counterpart to /story-point
  (which sizes one ticket) and a team-velocity report — use it to surface and
  estimate the unpointed-ticket backlog.
---

# Sprint Story-Point Audit

Find the current-sprint tickets that slipped through without a story-point estimate, surface the
**Done** ones first (they're the highest-value to fix — closed work with no estimate silently breaks
velocity math), and for each one pull the local AI session history that worked on it. That session
signal — sessions, prompts, lines changed, time — is real effort evidence you can anchor a point
estimate against, far better than guessing from the title alone.

The output is a **report with a recommended story-point value per ticket**. You do not write to Jira
automatically — the user applies the values manually or via `/story-point`. (If the user explicitly
asks you to apply them, you may, but confirm the list first.)

## Configuration

Fill these in for your workspace before first use — everything except the point
scale is org-specific. The values come from `.env` / `.ai-contexts`, not from
this file, so nothing here needs editing per run.

```
Jira project:      $JIRA_PREFIX  (site: $JIRA_HOST — resolve its cloud ID once via
                   the Atlassian MCP `getAccessibleAtlassianResources`)
Story Points field: your Jira Story Points custom field id, e.g. <story-points-field>
                   (number; empty/null = missing). Find it via
                   `getJiraIssueTypeMetaWithFields` on any project issue type.
Done status:       "Done"  (statusCategory "Done" also covers any close-equivalent statuses)
Auth:              ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN from .env (unified Atlassian
                   token — one token covers both Jira and Bitbucket Cloud)
Default user:      the session user — scope to assignee = currentUser()
Point scale:       0.5, 1, 2, 3, 5, 8, 13
Session data:      .ai-memory/session-end-events.jsonl  (+ session-end-events-YYYY-MM.jsonl partitions)
Bitbucket:         workspace = $BITBUCKET_WORKSPACE; repos = $SP_AUDIT_REPOS (comma-separated)
                   Ticket key lives in the PR source branch (feature/PROJ-####-...) and/or title.
Calibration:       .claude/commands/_story-point-calibration.md  (read before recommending)
```

## Workflow

### Step 1 — Pull the unpointed current-sprint tickets

Use the Atlassian MCP `searchJiraIssuesUsingJql` against your site's cloud ID.
Default scope is the user's own tickets in the open sprint with no story points:

```
project = <JIRA_PREFIX> AND sprint in openSprints() AND assignee = currentUser() AND cf[<story-points-field-id>] is EMPTY
ORDER BY statusCategory DESC, updated DESC
```

Request fields: `summary, status, assignee, issuetype, <story-points-field>, updated, parent`.
`statusCategory DESC` floats Done/closed tickets to the top, which matches the "prioritize the done
ones" requirement. If the user asks for the whole sprint (all assignees), drop the `assignee` clause.

If the query returns nothing, say so plainly — an empty result is a *good* outcome (every ticket is
pointed), not an error.

### Step 2 — Match each ticket to real effort (PRs first, then local sessions)

Two matchers, run both in one call each. **Bitbucket PRs are the stronger signal** — the ticket key
lives in the merged PR's source branch (`feature/PROJ-####-...`) and/or title, and the diffstat gives
actual lines changed + files touched. The AI session log is supplementary: it only matches when the
session-attribution hook tagged `primary_jira_ticket`, which is sparse, so treat a session miss as
"unknown," not "no work."

**Bitbucket PRs (primary):**

```bash
node .claude/skills/sprint-sp-audit/scripts/match_prs.js PROJ-865 PROJ-866 ... --author "Jane Doe"
```

Returns JSON keyed by ticket: matched `prs` (id, title, branch, author, merged_on, lines_added/removed,
files_changed, link) plus aggregate `pr_count`, `net_lines`, `files_changed`. It queries each repo with
a targeted `state="MERGED" AND (title~"KEY" OR source.branch.name~"KEY")` filter — cheap and exact.
Drop `--author` to match PRs by anyone (use that for whole-sprint audits). An empty `prs` array means no
merged PR references that key — which for a *Done* ticket is itself worth flagging (closed without a
key-tagged PR: bundled under a sibling ticket, hotfixed, or done outside these repos).

**AI sessions via the attribution field (fast, but lossy):**

```bash
node .claude/skills/sprint-sp-audit/scripts/match_sessions.js PROJ-865 ... --user "Jane Doe"
```

Dedupes the cumulative session snapshots (the log appends a fresh cumulative row each time a session
ends, so a single session can appear 100+ times — never sum raw rows) and aggregates `sessions`,
`prompts`, `cost_usd`, `net_lines`, `duration_hours`, `users`, and contributing `session_ids`. Drop
`--user` to match across the team.

**Do not trust a zero here.** This reads the session log's `primary_jira_ticket`, which is derived by
commit-key heuristics and fails exactly where this skill operates: it's empty for unkeyed hotfixes,
single-valued even though one long session routinely spans several tickets (a 9-day session can cover
PROJ-550 *and* three hotfix tickets), and date-collapsed by the snapshot dedup. A ticket whose work was
clearly done in Claude Code can still come back `sessions: 0`. When that happens, go to the transcripts.

**AI sessions via transcript content (ground truth):**

```bash
node .claude/skills/sprint-sp-audit/scripts/match_transcripts.js --ticket PROJ-865 \
  --term "fix/duplicate-invoice-rows" --term "String(order.id) === String(line.order.id)"
```

The CC transcripts under `~/.claude/projects/` record the branches pushed, commit subjects, and files
edited — so they tie a session to its work even when the attribution field is blank. Feed it signal
terms from the semantic PR match: the **branch name** and, more discriminating, a **distinctive code
string or commit sha** from the diff. A branch name alone also matches sessions that merely *discussed*
the work (including this audit run); the session that actually wrote the fix is the one where the unique
code string appears and whose entry window sits at the work date — prefer it. Note CC logs by cwd-hash,
so repo work done through a workspace symlink lands under the *workspace* project, not a repo-named dir.

**Semantic fallback (run this whenever a Done/In-Progress ticket got no keyword PR hit):**

Many real PRs — especially direct-to-master hotfixes — never carry the ticket key *anywhere* (branch is
descriptive like `hotfix/networth-assets-excluded-master`, title has no key, and the description is just
the PR template). Keyword matching cannot find these. So when a ticket that clearly involved code comes
back with no PR, pull the candidate pool and match by **meaning**:

```bash
node .claude/skills/sprint-sp-audit/scripts/recent_prs.js --author "Jane Doe" --since <~30d before ticket resolved> --limit 40
```

It returns recent merged PRs with `title`, `description`, `branch`, `net_lines`, `files_changed`. Read
each and map it to the unmatched ticket by what it actually fixes — e.g. a PR titled *"include requested
asset holdings in NetWorth summary"* is obviously the fix for *"NetWorth – assets not included in Net
Worth calculation,"* even with zero shared key. State the match and your confidence; a human can eyeball
it from the titles you cite.

**Dedupe the master/staging twins.** This repo's convention pairs every fix as a master PR *and* a
`-staging` PR with the same change ([[my-backend-staging-pr-convention]]). They are the same work cut
twice — count the diff **once** (use the master side) or you'll double the effort signal. Likewise, a
single ticket may be resolved by *several* small hotfixes (an urgent prod bug often takes 3–4 round
trips); sum the master-side diffs across them — the iteration count itself is a sizing signal (a fix
that needed four passes is rarely a 0.5).

Sizing precedence: keyword-matched PR diff → semantically-matched PR diff → session effort → ticket
content only (and say which, so every recommendation's evidence is visible).

### Step 3 — Recommend a story point per ticket

First read `.claude/commands/_story-point-calibration.md` — it holds real Lane tickets and the points
they got, and it's the source of truth for sizing. Then for each ticket combine two signals:

1. **The ticket itself** — scope, complexity, layer (FE/BE/full-stack), risk, unknowns.
2. **The matched session effort** — this is the differentiator this skill adds. Use it as corroboration,
   not gospel: a ticket with `net_lines` in the thousands across several sessions and many hours is
   almost certainly not a 0.5; a ticket closed in one short session with a handful of changed lines
   probably is. But large `net_lines` can also mean generated code or churn, and `sessions: 0` doesn't
   mean zero effort — so let the calibration anchors lead and the effort signal adjust.

Snap every recommendation to the scale (0.5, 1, 2, 3, 5, 8, 13). State which calibration example you
anchored on and, in one phrase, how the session signal moved it.

### Step 4 — Report

Lead with a one-line summary (`N unpointed tickets — M Done, K in progress/other`). Then a table,
**Done tickets first**:

```
| Ticket | Status | Summary | PRs | Net lines | Files | Sessions | Rec. SP | Anchor |
|--------|--------|---------|----:|----------:|------:|---------:|--------:|--------|
| PROJ-867 | Done | Loan-account balance classification | 2 | 526 | 6 | 0 | 2 | PROJ-855 (BE fix), PR diff confirms contained |
```

"Net lines"/"Files" come from the PR diffstat when a PR matched, else from session effort. After the
table, list tickets with **no PR and no session match** separately under "No effort evidence —
estimated from ticket only," so it's transparent which recommendations are unbacked. For Done tickets
in that bucket, note the anomaly (a closed ticket with no key-tagged PR usually means it was fixed under
a sibling ticket, hotfixed, or closed administratively — worth a glance). Close with the exact
follow-up, e.g. *"Apply with `/story-point PROJ-865` or tell me to set them all."*

## Notes

- **Read-only by default.** Never write `<story-points-field>` unless the user explicitly approves the list.
  When you do, follow `/story-point`'s rule: include `assignee` in every `editJiraIssue` call so the MCP
  doesn't clear it as a side effect.
- The session log is git-tracked and shared, so `--user` matters: without it you aggregate the whole
  team's effort on a ticket, which is the right call only when auditing the full sprint.
- This skill answers "what's unpointed and roughly how big" — it is not a velocity report. For team
  throughput / DORA / AI cost, use your team-metrics report.
