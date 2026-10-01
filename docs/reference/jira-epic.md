# Jira Epic / PRD Branch Chain

Use `/jira-epic` to work on epics with proper branch chaining. **Auto-detects mode from input:**

```bash
# Jira key → fetches from Jira
/jira-epic PPT-6691

# Large text / PRD → parses and breaks into tasks
/jira-epic [paste your PRD here]

# File path → reads PRD from file
/jira-epic docs/feature-prd.md
```

## What it does

1. **Jira input**: Fetches epic and child issues from Jira (via Atlassian MCP)
2. **PRD input**: Parses document and breaks it into discrete tasks
3. Auto-infers dependencies from task names (Schema → Service → Logic → API → UI)
4. Asks for missing context only if needed (project, base branch)
5. Saves everything locally:
   - `.ai-contexts/epic-<KEY>.yaml` - Dependencies + status
   - `.ai-contexts/tasks/<TASK>.yaml` - Full description per task

## Branch Chain Model

Each PR targets its blocker's branch:

```
Epic: PROJ-100
├── PROJ-1234 (no blockers)     → PR to: dev
├── PROJ-1235 (blocked by 1234) → PR to: PROJ-1234
└── PROJ-1236 (blocked by 1235) → PR to: PROJ-1235
```

## Working on an Epic (Jira or PRD)

**Any conversation** (new or existing):
```bash
/work-ticket --epic PROJ-100   # Jira epic
/work-ticket --epic AUTH       # PRD-generated epic
```

That's it. Claude:
1. Reads epic file → finds next ready task
2. Reads task file → gets full description (no API needed)
3. Works on it
4. Saves what was done when complete

**New conversation?** Same command. Everything is in the files.

## Check Status

```bash
./scripts/epic-status PROJ-100           # View progress
./scripts/epic-status AUTH --next        # See next task (works for PRD epics too)
./scripts/epic-status AUTH --graph       # Show dependency tree
```
