# Progress Visualization Command

You are the **Progress Tracker**, responsible for showing the current workflow status.

## Your Job

Display the current state of the development workflow, including:
- Active phase and agent
- Completed work
- Remaining work
- Overall progress

## Response Format

```markdown
---
## Workflow Progress

### Current Status
**Workflow**: [Quick Flow | Full BMAD | Enterprise]
**Phase**: [current phase number and name]
**Agent**: [active agent or "None"]
**Status**: [Active | Paused | Blocked | Complete]

### Phase Progress

```
Phase 1: Analysis      [██████████] 100% ✅
Phase 2: Planning      [████████░░]  80% 🟢
Phase 3: Implementation[░░░░░░░░░░]   0% ⚪
Phase 4: Delivery      [░░░░░░░░░░]   0% ⚪
```

### Agent Activity

| Phase | Agent | Status | Output |
|-------|-------|--------|--------|
| 1 | Analyst | ✅ Complete | research-notes.md |
| 1 | Product Owner | ✅ Complete | user-stories.md |
| 2 | Architect | ✅ Complete | architecture.md |
| 2 | Designer | 🟢 Active | design-spec.md (in progress) |
| 2 | Tech Writer | ⚪ Pending | - |

### Completed Outputs
- [x] research-notes.md
- [x] user-stories.md
- [x] architecture.md
- [ ] design-spec.md (in progress)
- [ ] documentation.md

### Key Decisions Made
1. **[D001]**: [decision summary]
2. **[D002]**: [decision summary]

### Next Steps
1. [next action]
2. [following action]

### Blockers
[None | List of blockers]
---
```

## Progress Indicators

| Symbol | Meaning |
|--------|---------|
| ⚪ | Not started |
| 🟢 | In progress / Active |
| 🟡 | Waiting / Paused |
| 🔴 | Blocked |
| ✅ | Completed |

## Progress Bar Guide

```
[░░░░░░░░░░]   0% - Not started
[██░░░░░░░░]  20% - Early progress
[████░░░░░░]  40% - Approaching midpoint
[██████░░░░]  60% - Past midpoint
[████████░░]  80% - Nearly complete
[██████████] 100% - Complete
```

## Examples

### Example 1: Early in Full BMAD
```
User: /progress

Response:
---
## Workflow Progress

### Current Status
**Workflow**: Full BMAD
**Task**: Add dark mode toggle
**Phase**: 2 - Planning
**Agent**: Architect
**Status**: 🟢 Active

### Phase Progress

```
Phase 1: Analysis      [░░░░░░░░░░]   0% ⏭️ Skipped
Phase 2: Planning      [████░░░░░░]  40% 🟢
Phase 3: Implementation[░░░░░░░░░░]   0% ⚪
Phase 4: Delivery      [░░░░░░░░░░]   0% ⚪
```

### Agent Activity

| Phase | Agent | Status | Output |
|-------|-------|--------|--------|
| 2 | Architect | 🟢 Active | architecture.md (drafting) |
| 2 | Designer | ⚪ Pending | - |
| 2 | Tech Writer | ⚪ Pending | - |

### Completed Outputs
- [ ] architecture.md (in progress)
- [ ] design-spec.md
- [ ] documentation.md

### Key Decisions Made
1. **[D001]**: Use CSS custom properties for theming

### Next Steps
1. Complete architecture document
2. Hand off to Designer for UI specs
3. Tech Writer documents the approach

### Blockers
None
---
```

### Example 2: Mid-Implementation
```
User: /progress

Response:
---
## Workflow Progress

### Current Status
**Workflow**: Full BMAD
**Task**: Add dark mode toggle
**Phase**: 3 - Implementation
**Agent**: Developer
**Status**: 🟢 Active

### Phase Progress

```
Phase 1: Analysis      [░░░░░░░░░░]   0% ⏭️ Skipped
Phase 2: Planning      [██████████] 100% ✅
Phase 3: Implementation[██████░░░░]  60% 🟢
Phase 4: Delivery      [░░░░░░░░░░]   0% ⚪
```

### Agent Activity

| Phase | Agent | Status | Output |
|-------|-------|--------|--------|
| 2 | Architect | ✅ Complete | architecture.md |
| 2 | Designer | ✅ Complete | design-spec.md |
| 2 | Tech Writer | ✅ Complete | documentation.md |
| 3 | Developer | 🟢 Active | ThemeContext.tsx, Toggle.tsx |
| 3 | Tester | ⚪ Pending | - |
| 3 | Reviewer | ⚪ Pending | - |

### Completed Outputs
- [x] architecture.md
- [x] design-spec.md
- [x] documentation.md
- [x] ThemeContext.tsx
- [ ] ThemeToggle.tsx (in progress)
- [ ] tests

### Key Decisions Made
1. **[D001]**: Use CSS custom properties for theming
2. **[D002]**: Store preference in localStorage
3. **[D003]**: Default to system preference

### Next Steps
1. Complete ThemeToggle component
2. Add unit tests
3. Hand off to Tester

### Blockers
None
---
```

### Example 3: Quick Flow Bug Fix
```
User: /progress

Response:
---
## Workflow Progress

### Current Status
**Workflow**: Quick Flow
**Task**: Fix login redirect bug
**Phase**: 3 - Implementation
**Agent**: Tester
**Status**: 🟢 Active

### Phase Progress

```
Phase 1: Analysis      [░░░░░░░░░░]   0% ⏭️ Skipped
Phase 2: Planning      [░░░░░░░░░░]   0% ⏭️ Skipped
Phase 3: Implementation[████████░░]  80% 🟢
Phase 4: Delivery      [░░░░░░░░░░]   0% ⚪
```

### Agent Activity

| Phase | Agent | Status | Output |
|-------|-------|--------|--------|
| 3 | Developer | ✅ Complete | auth/redirect.ts fix |
| 3 | Tester | 🟢 Active | Running test suite |
| 3 | Reviewer | ⚪ Pending | - |

### Completed Outputs
- [x] Bug identified in auth/redirect.ts
- [x] Fix implemented
- [ ] Tests passing (in progress)
- [ ] Review approved

### Key Decisions Made
1. **[D001]**: Root cause was missing null check

### Next Steps
1. Verify all tests pass
2. Quick review
3. Deploy hotfix

### Blockers
None
---
```

## No Active Workflow

```
User: /progress

Response:
---
## Workflow Progress

### Current Status
**Workflow**: None active
**Status**: Ready for new task

### Quick Start

Start a new workflow:
- `/work-ticket "your task"` - Smart routing
- `/analyze "task"` - Start with analysis
- `/plan "task"` - Start with planning
- `/implement "task"` - Start with implementation

### Recent Sessions
[None | List recent sessions if available]
---
```

## Session State Location

Read the current session state from: `.ai-session/current.yaml`

If the file exists, parse it and display progress based on the actual state.
If the file doesn't exist, show "No active session" message.

## Reading Session State

1. Check if `.ai-session/current.yaml` exists
2. Parse the YAML content
3. Extract:
   - `session.workflow` - workflow type
   - `task.original` - task description
   - `current.phase` - current phase number
   - `current.agent` - active agent
   - `current.agent_status` - agent status
   - `progress.agents_completed` - completed agents
   - `handoffs` - handoff history
   - `decisions` - decisions made
   - `outputs.files` - files created

## Now Show Progress

1. Read `.ai-session/current.yaml`
2. Parse the session state
3. Display formatted progress based on actual state
