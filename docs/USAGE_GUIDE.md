# Lane - Usage Guide

Step-by-step guidance for using **Lane** (phase-based AI workflow) in Claude Code CLI (Terminal) and Cursor IDE environments.

---

## Quick Start

```bash
# Start any task - the AI routes it automatically
/work-ticket "Your task description here"
```

That's it. The orchestrator analyzes your task and activates the right workflow.

---

## Prerequisites

### For Claude Code CLI (Terminal)

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | 18+ | `node --version` |
| Claude Code CLI | Latest | `claude --version` |
| Git | Any | `git --version` |

**Installation:**
```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version
```

### For Cursor IDE

| Requirement | Version |
|-------------|---------|
| Cursor IDE | Latest |
| Claude extension | Enabled |
| Node.js | 18+ (for MCP services) |

**Setup:**
1. Open Cursor IDE
2. Enable Claude integration in settings
3. Open this workspace folder

---

## Environment Setup

### Claude Code CLI (Terminal)

```bash
# 1. Clone the workspace
git clone https://github.com/mazaia/lane.git
cd lane

# 2. Run setup script
./scripts/setup

# 3. Start Claude Code
claude

# 4. Begin working
/work-ticket "Add dark mode toggle"
```

**Terminal Environment Features:**
- Full keyboard navigation
- Direct file system access
- Git integration built-in
- Session state in `.ai-session/current.yaml`

### Cursor IDE

1. **Open Workspace**: File > Open Folder > select `lane`

2. **Verify MCP Configuration**: Check `.mcp.json` is detected (status bar)

3. **Open Claude Panel**:
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows)
   - Type "Claude" and select "Open Claude Panel"

4. **Start Working**:
   ```
   /work-ticket "Add dark mode toggle"
   ```

**Cursor IDE Features:**
- Visual file tree integration
- Inline code suggestions
- Split view with editor
- Same session state (`.ai-session/current.yaml`)

---

## Core Workflow

### Step 1: Start a Workflow

Choose how to begin:

| Entry Point | Command | Best For |
|-------------|---------|----------|
| **Smart Router** | `/work-ticket "task"` | Most tasks - AI decides workflow |
| **Bug Fix** | `/work-ticket "fix bug..."` | Quick fixes (5 min) |
| **Feature** | `/work-ticket "add feature..."` | New functionality (15 min) |
| **System** | `/work-ticket "build system..."` | Large projects (30 min) |

**Example:**
```bash
/work-ticket "Add user authentication with JWT"

# AI Response:
# Task Analysis
# Detected Workflow: Full BMAD
# Phases: Planning → Implementation → Delivery
# Starting with: Architect
```

### Step 2: Follow the Agents

The orchestrator activates agents in sequence:

```
Quick Flow:     Developer → Tester → Deployer
Full BMAD:      Architect → Designer → Developer → Tester → Reviewer → Deployer → Documenter
Enterprise:     Analyst → Product Owner → Architect → Designer → Developer → Tester → Reviewer → Deployer → Documenter
```

**Agent Handoffs are Automatic:**
- Each agent completes their work
- Handoff summary appears in conversation
- Next agent activates immediately
- You just watch and provide input when asked

### Step 3: Deliver Output

The workflow ends when:
1. **Deployer** creates a PR or deploys code
2. **Documenter** finalizes documentation
3. Session status becomes "completed"

Check final status:
```bash
/progress
```

---

## Command Reference

### Essential Commands

| Command | Description | When to Use |
|---------|-------------|-------------|
| `/work-ticket "task"` | Start smart workflow | Beginning any task |
| `/progress` | View current status | Check where you are |
| `/agent [name]` | Switch to specific agent | Manual control needed |
| `/handoff` | Explicit transition | Force move to next agent |

### Phase Commands

| Command | Description |
|---------|-------------|
| `/analyze "task"` | Start in Analysis phase |
| `/plan "task"` | Start in Planning phase |
| `/implement "task"` | Start in Implementation phase |
| `/deliver "task"` | Start in Delivery phase |

### Epic / PRD Commands

| Command | Description |
|---------|-------------|
| `/jira-epic PROJ-123` | Fetch Jira epic, build dependency chain |
| `/jira-epic [PRD text]` | Parse PRD, break into tasks |
| `/work-ticket --epic KEY` | Resume work on epic (Jira or PRD) |

**PRD Mode**: Just paste a large PRD document after `/jira-epic` - Lane auto-detects it's not a Jira key and parses it into tasks with dependencies.

### Session Management

| Command | Description |
|---------|-------------|
| `/start-session` | Initialize new session |
| `/add-project` | Add project to workspace (auto-detects git platform) |

---

## Session State

The orchestrator tracks state in `.ai-session/current.yaml`:

```yaml
session:
  id: "20260115-093045"
  workflow: "full-bmad"

task:
  original: "Add dark mode toggle"

current:
  phase: 2
  agent: "architect"
  agent_status: "active"

progress:
  agents_completed:
    - architect

outputs:
  files:
    - "docs/architecture.md"
```

**View current session:**
```bash
# Terminal
cat .ai-session/current.yaml

# Or use the command
/progress
```

---

## MCP Services

The workspace includes 4 pre-configured MCP services:

| Service | Purpose | Used By |
|---------|---------|---------|
| **Context7** | Up-to-date documentation | All agents |
| **Figma** | Design integration | Designer, Developer |
| **Playwright** | Browser automation | Tester |
| **Sequential Thinking** | Complex reasoning | Architect, Analyst |

**Services start automatically** when needed. No manual configuration required.

---

## Tips & Best Practices

### For Terminal Users

1. **Use Tab Completion**: Claude Code supports tab completion for commands
2. **Check Progress Often**: Run `/progress` to stay oriented
3. **Trust Handoffs**: Let agents hand off automatically

### For Cursor IDE Users

1. **Split View**: Keep Claude panel open alongside your code
2. **Use Inline Suggestions**: Accept AI suggestions with Tab
3. **Watch File Tree**: New files appear as agents create them

### General Tips

| Tip | Description |
|-----|-------------|
| **Be Specific** | "Add JWT auth with refresh tokens" > "Add auth" |
| **Provide Context** | Share constraints, preferences, existing patterns |
| **Let It Flow** | Don't interrupt handoffs unless necessary |
| **Review PRs** | Always review before merging |

---

## Troubleshooting

### "No active session"

```bash
# Start a new workflow
/work-ticket "your task"
```

### "Agent not responding"

```bash
# Check current status
/progress

# Manually activate agent if needed
/agent developer
```

### MCP Services Not Working

```bash
# Verify Node.js
node --version  # Should be 18+

# Check MCP config exists
cat .mcp.json

# Restart Claude Code
exit
claude
```

### Session State Corrupted

```bash
# Reset session
rm -rf .ai-session/
/work-ticket "your task"
```

---

---

## Epic / PRD Workflows

### Working with Jira Epics

```bash
# Fetch epic and build task dependency chain
/jira-epic PPT-6691

# Resume working on epic tasks
/work-ticket --epic PPT-6691
```

### Working with PRDs

```bash
# Paste PRD directly - Lane auto-detects and parses
/jira-epic [paste your PRD document here]

# Or reference a file
/jira-epic docs/feature-prd.md
```

Lane will:
1. Parse the PRD content
2. Extract discrete tasks
3. Infer dependencies (Schema → Service → API → UI → Tests)
4. Generate task files in `.ai-contexts/`
5. Allow resuming with `/work-ticket --epic <PREFIX>`

**Same workflow, different sources** - whether from Jira or PRD, the task chain works identically.

---

## Spec-to-Implementation Pipeline

Lane can take you from idea to running code through a structured pipeline:

| Command | Description |
|---------|-------------|
| `/spec "task"` | Generate a structured PRD (Product Requirements Document) |
| `/breakdown <spec-file>` | Create a wave-based implementation plan from a spec |
| `/swarm-implement <plan>` | Execute the plan with parallel agent teams |

**Example flow:**
```bash
# 1. Generate a spec
/spec "Add role-based access control"

# 2. Break it into waves of parallel tasks
/breakdown docs/specs/rbac-spec.md

# 3. Execute with agent swarm
/swarm-implement docs/plans/rbac-plan.md
```

The pipeline produces structured artifacts at each stage, so you can review and adjust before moving to the next step.

---

## Self-Improvement System

Lane learns from every session and continuously improves its behavior through a rule-based self-improvement system.

- **Rules auto-injected on every prompt** — 58 team rules + personal rules are applied automatically via a lightweight hook
- **No external services required** — rules are stored as JSON and matched by keyword, no vector database needed

### Useful commands

| Command | Description |
|---------|-------------|
| `npm run self:dashboard` | Interactive dashboard showing rules, stats, and pending proposals |
| `npm run rules:promote` | Promote a personal rule to a shared team rule |

---

## Analysis Scripts

Utility scripts for codebase analysis and workflow optimization:

| Script | Description |
|--------|-------------|
| `./scripts/deep-map <project>` | Deep codebase analysis — maps structure, dependencies, and patterns |
| `./scripts/wave-planner` | Task parallelization — groups tasks into waves that can run concurrently |
| `./scripts/fresh-context` | Combat context rot — regenerates stale cached context |
| `./scripts/snapshot-compare` | Before/after performance comparison between snapshots |

---

## Next Steps

- [Validation Process](VALIDATION_PROCESS.md) - Understanding quality gates and PR workflow
- [Slash Commands](SLASH_COMMANDS.md) - Commands for token optimization
- [Agent Guide](../AGENT_GUIDE.md) - Detailed agent capabilities
- [Methodology](../METHODOLOGY.md) - BMAD methodology explained

---

**Ready to start?** Run `/work-ticket "Your first task"` in your preferred environment.
