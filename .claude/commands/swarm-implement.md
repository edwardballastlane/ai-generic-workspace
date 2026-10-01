---
name: swarm-implement
description: Execute an implementation plan using agent teams for parallel task execution. Uses plan mode — surfaces the execution plan (teammates, file ownership, wave sequencing) for approval before spawning.
argument-hint: <plan-file-path>
---

# Swarm Implement — Execute Plan with Agent Teams

You are executing an **implementation plan** using Claude Code agent teams for parallel task execution.

**Input:** $ARGUMENTS

## Plan Mode

**Enter plan mode** (`EnterPlanMode`) BEFORE spawning any agent team. Present the execution plan: which subagents will be spawned, with what tasks, against what files, and in what wave sequence. Let the user approve or revise.

This prevents unintended parallel execution — agent teams modify many files quickly, so the user should see the orchestration plan before it runs.

## Prerequisites Check

1. **Agent teams must be enabled**: Check if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is set.
   If NOT enabled, inform the user:
   ```
   Agent teams are not enabled. To enable:
   1. Add to .claude/settings.json:
      { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
   2. Restart Claude Code

   Alternatively, I can execute the plan sequentially without agent teams.
   Proceed sequentially? (The wave-planner output still helps prioritize order.)
   ```

2. **Load the plan**: Read the plan file from `$ARGUMENTS` or the most recent plan in `docs/plans/`

3. **Verify the spec exists**: The plan should reference its source spec

## Step 1: Parse the Wave Plan

Read the plan file and extract:
- Number of waves
- Tasks per wave with dependencies
- Agent assignments (which teammate type handles each task)
- File ownership (which files each task modifies)

## Step 2: Inject Context for Teammates

Each teammate needs:
- **The spec**: so they understand the full picture
- **Their specific tasks**: from the plan
- **Team rules**: from `scripts/self-improvement/rules-shared.json` (inject top relevant rules)
- **File ownership**: which files they own (to avoid conflicts)
- **Codebase context**: relevant deep-map or project context from `.ai-contexts/`

## Step 3: Create the Agent Team

**Route each teammate to a cost-appropriate model first.** For every task, derive the model from the routing heuristic instead of defaulting everything to Opus:

```bash
node scripts/agent-router.js --agent <agent-type> --complexity <low|medium|high> --files <count> --desc "<task title>"
# prints: haiku | sonnet | opus
```

Use the task's `complexity` flag from the plan and the number of files it owns. Trivial/mechanical tasks (low complexity, typos, renames) route to **haiku**; high-complexity, multi-file (>3), or security/architecture-sensitive tasks route to **opus**; review/planning/test roles route to **sonnet**. Spawn each teammate with the returned `model`. (Same idea as `/brainstorm` pinning its tasks to haiku — just per-task.)

Create an agent team with teammates for each role identified in the plan. Use the subagent definitions we created:

```
Create an agent team to implement this plan.

Spec: <path to spec>
Plan: <path to plan>

Teammates needed:
- "backend-dev" using implementer agent type (model: <router output>): Tasks T-1, T-2, T-3
  Files owned: src/models/currency.ts, src/api/currency.controller.ts
  Prompt: "You are implementing the backend tasks from the plan at <path>.
  Read the spec at <path> first. Your tasks are T-1 (data model), T-2 (API endpoint),
  T-3 (validation). Only modify files in src/models/ and src/api/currency*.
  Team rules to follow: <inject top 5 relevant rules>"

- "test-writer" using implementer agent type (model: <router output>): Tasks T-4, T-5
  Files owned: tests/currency.spec.ts, tests/currency.e2e.ts
  Prompt: "You are writing tests for the plan at <path>.
  Read the spec at <path> first. Wait for Wave 1 to complete before starting T-5.
  Your tasks are T-4 (fixtures), T-5 (integration tests).
  Team rules to follow: <inject relevant testing rules>"
```

**Verification is no longer a single trailing reviewer task** — every implementation task is gated by an independent consensus panel (Step 4.5). You do not need to add a standalone "code-reviewer" task to the team.

## Step 4: Wave Execution

The agent team's shared task list handles wave ordering:
- Tasks in Wave 1 have no dependencies → teammates claim them immediately
- Tasks in Wave 2 depend on Wave 1 → they unblock automatically when Wave 1 completes
- The code-reviewer waits for all implementation waves

**Monitor progress**: The lead tracks task completion across teammates.

## Step 4.5: Consensus Verification (per task)

**No implementer's work is accepted on self-verification alone.** When a teammate marks an implementation task complete, gate it with an **independent verification panel** before the task is considered done. Verifiers are read-only and run **concurrently** — each casts its vote without seeing the others'.

### Build the panel

- **projects with dedicated reviewer agents** (a workspace can define per-project reviewers under `.claude/agents/<project>/`, e.g. `architecture-reviewer`, `security-reviewer`, `performance-reviewer`, `conventions-reviewer`) → use those as the panel, each voting on its own dimension.
- **all other projects** → spawn **3 `verifier` agents** (see `.claude/agents/verifier.md`), each independently prompted to *refute* that the task meets its acceptance criteria.

Give every panelist: the task (id, description, acceptance criteria), the diff/files the implementer changed, and the source spec. Verifiers run on **sonnet** (cheap, independent votes).

### Tally the votes

- **Any `BLOCKER` finding from any panelist = veto → FAIL** (Byzantine-style: one credible blocker sinks the task regardless of the count).
- Otherwise **accept only on a majority PASS** (dimension panel: ≥ 3 of 4 dimensions PASS with zero blockers; generic panel: ≥ 2 of 3 verifiers PASS).
- Anything else → **FAIL**.

### On FAIL — auto fix-and-re-review loop

1. Aggregate the panel's findings (dedupe by file:line) and hand them back to the **owning implementer** to fix.
2. Re-run the panel on the updated change.
3. **Cap at 2 retries.** If it still fails after retry 2, **halt the wave** and report the outstanding findings + verdicts for a human to resolve. Do not silently proceed.

Record each task's verdict (and any retries) for the Step 6 report.

## Step 5: Quality Gates

After all tasks complete:

1. **Verify all acceptance criteria**: Check each criterion from the spec
2. **Run the full test suite**: `npm test` in the project
3. **Run lint/type-check**: Ensure no regressions
4. **Check for file conflicts**: Verify no teammate overwrote another's files
5. **Run snapshot comparison**: If performance-sensitive:
   ```bash
   ./scripts/snapshot-compare after <project>
   ```

## Step 6: Report Results

```
Swarm Implementation Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Spec: <spec-path>
Plan: <plan-path>

Results (consensus-gated):
  Wave 1: ✓ T-1 (panel 4/4, 0 blockers)
          ✓ T-2 (panel 3/4, 0 blockers)
          ✓ T-3 ✗→fixed→✓ (retry 1)
  Wave 2: ✓ T-4, T-5 (panel pass)

Models used: T-1 opus, T-2 sonnet, T-3 sonnet, T-4 haiku, T-5 sonnet
Tests: all passing
Lint: clean
Acceptance criteria: 5/5 met

Files modified:
  src/models/currency.ts (new)
  src/api/currency.controller.ts (new)
  tests/currency.spec.ts (new)
  tests/currency.e2e.ts (new)

Next steps:
  - Review the changes: git diff
  - Create PR: /work-ticket --pr
  - Capture lessons: ./scripts/capture-lesson ...
```

## Fallback: Sequential Execution

If agent teams are NOT available, execute sequentially:
1. Work through Wave 1 tasks one at a time
2. Then Wave 2, etc.
3. Use subagents (not teams) for any parallelizable research within a wave
4. The wave-planner output still ensures correct ordering

This is slower but works without the experimental flag.
