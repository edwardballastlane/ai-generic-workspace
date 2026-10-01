# Context Manager

Manages context preservation, isolation, and retrieval across agents and phases.

## Purpose

The Context Manager ensures:
- Agents receive relevant historical context
- Decisions are preserved across handoffs
- Phase outputs are accessible to future agents
- Context doesn't pollute between unrelated tasks

## Context Structure

### Session Context

```yaml
session:
  id: "session-uuid"
  started: "2025-01-15T10:00:00Z"
  workflow: "full-bmad"
  status: "in-progress"

  task:
    original: "Add dark mode toggle to settings page"
    refined: "Implement theme switching with dark mode support, persisting user preference"

  current:
    phase: 3
    agent: developer
    status: active
    started: "2025-01-15T12:00:00Z"
```

### Phase Outputs

```yaml
outputs:
  phase_1:
    completed: false
    files: []

  phase_2:
    completed: true
    files:
      - path: "docs/architecture.md"
        agent: architect
        summary: "Theme system architecture using CSS variables"
      - path: "docs/design-spec.md"
        agent: designer
        summary: "Dark mode color palette and component variants"

  phase_3:
    completed: false
    files:
      - path: "src/contexts/ThemeContext.tsx"
        agent: developer
        summary: "React context for theme state management"
```

### Decision Log

```yaml
decisions:
  - id: D001
    phase: 2
    agent: architect
    timestamp: "2025-01-15T11:00:00Z"
    decision: "Use CSS custom properties for theming"
    rationale: "Better browser support, no runtime overhead"
    alternatives_considered:
      - "Styled-components theming"
      - "CSS-in-JS with emotion"
    impact: "All components will use var(--color-*) syntax"

  - id: D002
    phase: 2
    agent: architect
    timestamp: "2025-01-15T11:15:00Z"
    decision: "Store theme preference in localStorage"
    rationale: "Persists across sessions, no server needed"
    alternatives_considered:
      - "Cookie storage"
      - "User profile in database"
    impact: "Theme loads before React hydration"
```

### Knowledge Accumulation

```yaml
knowledge:
  constraints:
    - "Must support IE11 (CSS variables need fallback)"
    - "Bundle size increase < 5KB"
    - "No flash of unstyled content"

  assumptions:
    - "Users prefer system theme by default"
    - "Toggle should be accessible via keyboard"

  discoveries:
    - "Existing color tokens in design-system.css"
    - "Figma file has dark mode variants"
    - "Similar pattern in user-preferences module"

  risks:
    - risk: "Third-party components don't support theming"
      mitigation: "CSS override layer"
      status: "monitored"
```

## Context Operations

### Initialize Session

```markdown
WHEN: User starts new task
ACTION:
  1. Generate session ID
  2. Parse task description
  3. Determine workflow type
  4. Create empty context structure
  5. Store in session file
```

### Load Context for Agent

```markdown
WHEN: Agent activation
ACTION:
  1. Load session context
  2. Filter relevant phase outputs
  3. Compile decision summary
  4. Format for agent consumption
  5. Inject into agent prompt
```

### Save Agent Output

```markdown
WHEN: Agent produces output
ACTION:
  1. Record output in phase files
  2. Extract decisions made
  3. Update knowledge section
  4. Preserve for next agent
```

### Archive Session

```markdown
WHEN: Workflow complete
ACTION:
  1. Mark session complete
  2. Generate summary
  3. Move to archive
  4. Extract patterns for future reference
```

## Context Injection Format

When an agent is activated, they receive context as:

```markdown
---
## Session Context

**Task**: [refined task description]
**Workflow**: [workflow type]
**Current Phase**: [phase number and name]

### Previous Phase Summary
[Condensed summary of what happened in previous phases]

### Key Decisions
- **[D001]**: [decision summary] (by [agent])
- **[D002]**: [decision summary] (by [agent])

### Relevant Files
- `[path]`: [one-line summary]
- `[path]`: [one-line summary]

### Constraints & Assumptions
- [constraint or assumption 1]
- [constraint or assumption 2]

### Your Focus
[Specific guidance for this agent's role]
---
```

## Context Layers

Lane organizes context into 4 categorical layers. Each maps to an existing mechanism — this taxonomy names what already exists.

| Layer | What it contains | Where it lives | Lifecycle |
|-------|-----------------|----------------|-----------|
| **Product / Domain** | What the product does, who uses it, tech stack | `.ai-contexts/<project>.yaml` | Persists until project changes |
| **Architectural Invariants** | Constraints that must never break | Lessons (`severity: critical`) | Permanent until explicitly removed |
| **Codebase Conventions** | Patterns, style, component usage in this repo | Lessons (`category: code-quality`) | Permanent, evolves with project |
| **Task Context** | Current ticket/PR decisions, session state | `.ai-session/by-id/<sid>.yaml` (canonical) + `current.yaml` (back-compat mirror) | Dies with the session |

### Layer 1: Product / Domain

Generated by `./scripts/generate-context <project>` and cached at `.ai-contexts/<project>.yaml`. Contains tech stack, project structure, UI library, git configuration. **Read this file — don't ask for a context dump.**

### Layer 2: Architectural Invariants

Critical lessons that apply across all tasks (e.g., "Never use raw SQL — always use the ORM query builder"). Stored in `.ai-memory/lessons/` with `severity: critical`. Injected automatically via hooks.

### Layer 3: Codebase Conventions

Project-specific patterns (e.g., "Always use `@company/ui` Button, never raw HTML"). Stored in `.ai-memory/lessons/` with `category: code-quality`. Also injected automatically.

### Layer 4: Task Context

The current session: task description, decisions made, files changed, handoff history. Lives in `.ai-session/by-id/<claude_session_id>.yaml` (canonical per-cc-session) with a mirror at `.ai-session/current.yaml` for tools that don't know the active session id. Both die when the session ends.

## Token Discipline

Stable context (Layers 1-3) should be **referenced by path**, not pasted into prompts:

- **DO**: Read `.ai-contexts/<project>.yaml` when you need project details
- **DO**: Let hook injection handle lessons (they arrive automatically)
- **DON'T**: Copy entire context files into messages or handoff notes
- **DON'T**: Request "full context dumps" — read the specific file you need

Task context (Layer 4) is the only layer that should be summarized inline during handoffs, because it is ephemeral and session-specific.

## Context Storage

### During Session

```
.ai-session/
└── sessions/
    └── [session-id]/
        ├── context.yaml       # Main context file
        ├── decisions.yaml     # Decision log
        ├── outputs/           # Phase output references
        │   ├── phase-1/
        │   ├── phase-2/
        │   └── phase-3/
        └── knowledge.yaml     # Accumulated knowledge
```

### After Archive

```
.ai-session/
└── archive/
    └── [date]-[task-slug]/
        ├── summary.md         # Human-readable summary
        ├── context.yaml       # Full context snapshot
        └── outputs/           # Preserved outputs
```

## Context Queries

### Get Current Context

```markdown
/context
→ Returns current session context summary
```

### Get Decision History

```markdown
/context decisions
→ Returns all decisions with rationale
```

### Get Phase Outputs

```markdown
/context outputs [phase]
→ Returns outputs from specified phase
```

### Search Context

```markdown
/context search "[query]"
→ Searches across all context fields
```

## Context Cleanup

### Automatic Cleanup

```markdown
- Sessions older than 30 days → Archive
- Archives older than 90 days → Delete (unless starred)
- Temporary context → Delete on session end
```

### Manual Cleanup

```markdown
/context clear
→ Clears current session (with confirmation)

/context archive
→ Archives current session

/context prune
→ Removes old archives
```

## Integration Points

### With Orchestrator

- Orchestrator requests context for agent activation
- Orchestrator triggers context saves on handoffs
- Orchestrator manages session lifecycle

### With Agents

- Agents receive context on activation
- Agents record decisions via standard format
- Agents output preserved automatically

### With Commands

- `/progress` reads context for status
- `/agent` triggers context load
- `/phase` updates current phase in context

## Related

- [Orchestrator](orchestrator.md) - Uses context for coordination
- [Handoff Protocol](handoff-protocol.md) - Context transfer rules
- [Agent Registry](agent-registry.md) - Agent context requirements
