---
name: breakdown
description: Spec to implementation plan with dependency-aware task waves. Uses plan mode — presents the plan for approval before writing.
argument-hint: <spec-file-path or description>
---

# Breakdown — Spec to Implementation Plan

You are creating an **implementation plan** with dependency-aware task waves.

**Input:** $ARGUMENTS

## Plan Mode

**Enter plan mode** (`EnterPlanMode`) before writing any files. Produce the full breakdown as the plan, then let the user approve or revise. Only after approval: save files and present the summary.

This prevents runaway execution — the user should see the wave structure, team sizing, and task breakdown BEFORE anything is committed to disk.

## Step 1: Load the Spec

If `$ARGUMENTS` is a file path, read that spec file.
If `$ARGUMENTS` is a description, look for the most recent spec in `docs/specs/`.
If no spec exists, suggest running `/spec` first.

## Step 2: Gather Context

1. **Read the spec** thoroughly — every acceptance criterion must map to a task
2. **Identify the project**: Which project(s) does this affect?
3. **Read the codebase**: Use Glob/Grep to identify files that need changes
4. **Check team rules**: Read `scripts/self-improvement/rules-shared.json` for patterns

## Step 3: Generate the Breakdown

Use the `breakdown-planner` agent type to produce:

1. **Task list** with IDs, descriptions, file mappings, dependencies, complexity
2. **Wave plan** grouping tasks into parallel waves
3. **Agent team configuration** (if parallel execution makes sense)

Run the wave-planner to validate:
```bash
echo "<task list>" | ./scripts/wave-planner --markdown
```

## Step 4: Save the Plan

Save to: `docs/plans/plan-<timestamp>.md`

Also create a machine-readable version:
```bash
echo "<task list>" | ./scripts/wave-planner --json > docs/plans/plan-<timestamp>.json
```

## Step 5: Present for Approval

Show the plan summary:

```
Implementation Plan: <title>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tasks: N total across M waves
Max parallelism: P concurrent tasks

Wave 1 (parallel): T-1, T-2, T-3
Wave 2 (parallel): T-4, T-5
Wave 3 (sequential): T-6

Estimated team: N teammates
  - backend-dev: M tasks
  - test-writer: M tasks
  - code-reviewer: M tasks

Plan saved to: docs/plans/plan-<date>.md

Execute with:
  /swarm-implement docs/plans/plan-<date>.md
```

## If the Task is Simple

If the spec has < 3 tasks, skip the team approach:
```
This task is simple enough for a single session. No agent team needed.
Proceed with /work-ticket instead.
```
