# Spec — Generate a Structured PRD

You are generating a **formal specification** for the following task:

**Task:** $ARGUMENTS

## Step 1: Gather Context

Before writing anything:

1. **Detect the project**: Run `./scripts/list-projects` to see available projects. If the task mentions a specific project, focus on it.
2. **Read the codebase**: Use the `spec-writer` agent type to spawn a subagent that explores the relevant codebase and produces the spec.
3. **Check team rules**: Read `scripts/self-improvement/rules-shared.json` for patterns the team has learned.
4. **Check deep map**: If `.ai-contexts/<project>-deep-map.md` exists, read it for architecture context.

## Step 2: Generate the Spec

Spawn a subagent with the `spec-writer` agent type:

```
Use the spec-writer agent to generate a specification for: $ARGUMENTS

Context to include in the spawn prompt:
- The project name and path
- Relevant file paths from the codebase
- Any team rules that apply
- The deep-map summary if available
```

## Step 3: Save the Spec

Save the spec document to: `docs/specs/spec-<timestamp>.md`

Where `<timestamp>` is YYYY-MM-DD format.

## Step 4: Suggest Next Steps

After the spec is generated, suggest:

```
Spec saved to docs/specs/spec-<date>.md

Next steps:
  /breakdown docs/specs/spec-<date>.md    → Generate implementation plan with task waves
  /swarm-implement <plan-file>            → Execute the plan with agent teams
```

## If Agent Teams Are Available

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled, offer to spawn a spec review team:

```
Want me to create an agent team to review this spec from multiple angles?
- Technical feasibility reviewer
- Security implications reviewer
- Testing strategy reviewer

This uses Claude Code agent teams for parallel review.
```
