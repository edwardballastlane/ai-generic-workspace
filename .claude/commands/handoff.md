# Handoff Command

Execute a formal handoff from the current agent to the next agent in the workflow.

## Your Job

When this command is invoked, you must:

1. **Read the current session state** from `.ai-session/current.yaml`
2. **Generate the handoff summary** following the standard format
3. **Update the session state** with the new agent
4. **Display the handoff** visibly in the conversation

## Session File Location

The session state is stored in: `.ai-session/current.yaml`

## Handoff Execution

### Step 1: Load Current State

Read `.ai-session/current.yaml` to understand:
- Current agent and phase
- Work completed
- Decisions made
- Next agent in workflow

### Step 2: Generate Handoff Summary

Produce this VISIBLE output in the conversation:

```markdown
---
## Handoff Summary

**From**: [current agent]
**To**: [next agent]
**Phase**: [current] → [next if changing]
**Status**: Ready for handoff

### Completed Work
- [List what was accomplished]

### Key Decisions
| Decision | Rationale | Impact |
|----------|-----------|--------|
| [what] | [why] | [effect] |

### Context for Next Agent
[What the next agent needs to know to continue]

### Files Created/Modified
- `[file path]`: [description]

### Open Questions
- [Any unresolved items]

---
```

### Step 3: Update Session State (USE SCRIPTS!)

**You MUST use the session scripts to update state:**

```bash
# Mark current agent as completed
./scripts/update-session complete-agent "[current-agent]"

# Switch to next agent
./scripts/update-session agent "[next-agent]"

# If changing phases:
./scripts/update-session complete-phase [current-phase-number]
./scripts/update-session phase [new-phase-number] "[Phase Name]"

# Track any files created
./scripts/update-session add-output "[file-path]"
```

**DO NOT edit the session file manually!** Always use the scripts.

### Step 4: Activate Next Agent

After the handoff summary and session update, immediately activate the next agent with their context.

## Workflow Sequences

### Quick Flow
```
Developer → Tester → Deployer
```

### Full BMAD
```
Architect → Designer → Developer → Tester → Reviewer → Deployer → Documenter
         ↘ Tech Writer ↗
```

### Enterprise
```
Analyst → Product Owner → Architect → Designer → Developer → Tester → Reviewer → Deployer → Documenter
```

## Example Handoff

```markdown
---
## Handoff Summary

**From**: Architect
**To**: Designer
**Phase**: 2 - Planning
**Status**: Ready for handoff

### Completed Work
- Designed theme system architecture using CSS custom properties
- Defined data flow for theme state management
- Created API contract for theme context

### Key Decisions
| Decision | Rationale | Impact |
|----------|-----------|--------|
| CSS custom properties | Better performance, no runtime | All components use var(--color-*) |
| localStorage storage | Persists without server | Theme loads before hydration |
| System default | Better UX | Respects OS preference |

### Context for Next Agent
The architecture is ready. Designer needs to:
1. Create dark mode color palette based on existing design tokens
2. Design the toggle component UI
3. Specify component variants for both themes

### Files Created/Modified
- `docs/architecture.md`: Complete theme system architecture

### Open Questions
- Should toggle include "system" option alongside light/dark?

---

## Agent Activated

**Agent**: Designer
**Phase**: 2 - Planning
**Status**: Active

I'm now the Designer. Based on the architecture handoff, I'll create the visual design specifications for the dark mode feature...
```

## Error Cases

### No Active Session
```
No active session found.

Start a workflow first with:
- `/work-ticket "your task"`
- `/agent [agent-name]`
```

### End of Workflow
```
## Workflow Complete!

All phases have been completed for: [task]

### Summary
- Workflow: [type]
- Duration: [time]
- Agents involved: [list]

### Final Outputs
- [list of deliverables]

Session archived. Start a new task with `/work-ticket`.
```

## Now Execute Handoff

Read the current session state and execute the handoff to the next agent.
