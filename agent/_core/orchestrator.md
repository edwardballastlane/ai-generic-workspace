# Agent Orchestrator

The orchestrator coordinates agent activation, phase transitions, and handoffs throughout the development workflow.

## Critical Rules

**These rules MUST be followed by all agents:**

| Rule | Description |
|------|-------------|
| **Project Location** | ALL projects MUST be created in `agent/_projects/` |
| **Never Root** | NEVER create project files in repository root |
| **Docs in Project** | Each project has its own `docs/` folder |
| **README Required** | Every project MUST have a README.md |

## Core Functions

### 1. Agent Activation

When a user requests work, the orchestrator:

1. Analyzes the task using the Workflow Router
2. Determines the starting phase (Quick Flow, Full BMAD, or Enterprise)
3. Activates the appropriate agent
4. Provides context from previous phases

### 2. Phase Management

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Analysis   │ -> │  Planning   │ -> │Implementation│ -> │  Delivery   │
│   Phase 1   │    │   Phase 2   │    │   Phase 3    │    │   Phase 4   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     │                   │                   │                   │
  Analyst            Architect           Developer           Deployer
  Product Owner      Designer            Tester              Documenter
                     Tech Writer         Reviewer
```

### 3. Workflow Selection

| Workflow | Phases | Entry | Exit |
|----------|--------|-------|------|
| Quick Flow | 3 → 4 | Bug/fix detected | Deployed |
| Full BMAD | 2 → 3 → 4 | Feature request | Documented |
| Enterprise | 1 → 2 → 3 → 4 | System design | Full delivery |

## Orchestration Protocol

### Starting a Workflow

```markdown
1. User provides task via `/work-ticket "task"`
2. Workflow Router analyzes and selects workflow type
3. Orchestrator activates first phase
4. First agent receives:
   - Task context
   - Expected outputs
   - Handoff criteria
```

### During Execution

```markdown
1. Active agent works on task
2. Agent produces defined outputs
3. Agent signals completion via output format
4. Orchestrator validates outputs
5. Orchestrator triggers handoff to next agent
```

### Phase Transitions

```markdown
1. Current agent completes all outputs
2. Handoff protocol executed (see handoff-protocol.md)
3. Next agent receives:
   - Previous outputs
   - Task context
   - Phase-specific instructions
4. Previous agent context archived
```

## Agent States

| State | Description | Indicator |
|-------|-------------|-----------|
| `inactive` | Agent not in use | ⚪ |
| `active` | Currently working | 🟢 |
| `waiting` | Awaiting input | 🟡 |
| `blocked` | Needs resolution | 🔴 |
| `complete` | Finished task | ✅ |

## Context Management

The orchestrator maintains context between agents:

```yaml
context:
  task:
    original: "User's original request"
    refined: "Clarified task after analysis"

  phase_outputs:
    analysis:
      - requirements.md
      - research-notes.md
    planning:
      - architecture.md
      - design-spec.md
    implementation:
      - code-changes
      - test-results
    delivery:
      - deployment-log
      - documentation

  current:
    phase: 2
    agent: architect
    status: active

  decisions:
    - decision: "Use React for frontend"
      rationale: "Team expertise, project requirements"
      phase: 2
      agent: architect
```

## Commands

The orchestrator responds to these commands:

| Command | Action |
|---------|--------|
| `/agent [name]` | Activate specific agent |
| `/phase [number]` | Jump to phase |
| `/progress` | Show current status |
| `/handoff` | Trigger manual handoff |
| `/reset` | Reset to intake |

## Error Handling

### Agent Blocked

```markdown
1. Agent signals blocked status
2. Orchestrator pauses workflow
3. User prompted for resolution
4. Resolution recorded in context
5. Agent resumes with new information
```

### Phase Failure

```markdown
1. Phase outputs not meeting criteria
2. Orchestrator offers options:
   a. Retry current phase
   b. Return to previous phase
   c. Escalate to user
3. Decision recorded in context
```

## Integration Points

### MCP Services

The orchestrator coordinates MCP service access:

- **Context7**: Available to all agents for documentation
- **Figma**: Available to Designer and Developer agents

### External Tools

- Task tracking via TodoWrite
- File operations via standard tools
- Progress visualization via `/progress`

## Usage Example

```markdown
User: /work-ticket "Add dark mode toggle"

Orchestrator:
1. Analyzes task -> Feature request
2. Selects workflow -> Full BMAD
3. Determines start phase -> Phase 2 (Planning)
4. Activates -> Architect agent

Architect works...
Architect completes architecture.md

Orchestrator:
1. Validates architecture output
2. Executes handoff protocol
3. Activates -> Designer agent

[continues through phases...]
```

## Related

- [Agent Registry](agent-registry.md) - All available agents
- [Handoff Protocol](handoff-protocol.md) - Transition procedures
- [Context Manager](context-manager.md) - Context preservation
