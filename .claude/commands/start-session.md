# Start Session Command

Initialize a new workflow session with persistent state tracking.

## CRITICAL: Always Use the Script

**You MUST run the session script to create the session file:**

```bash
./scripts/start-session <workflow> "<task>" [project]
```

**DO NOT try to create the session file manually with Write/Edit tools.**
**ALWAYS use the Bash tool to run the script.**

## Usage Examples

```bash
# Quick flow for bug fixes
./scripts/start-session quick-flow "Fix login redirect bug" my-app

# Full BMAD for features
./scripts/start-session full-bmad "Add dark mode toggle" webapp

# Enterprise for large systems
./scripts/start-session enterprise "Build payment processing system" platform
```

## Workflow Types

| Workflow | First Agent | Phases | Use For |
|----------|-------------|--------|---------|
| `quick-flow` | Developer | 3-4 | Bug fixes, small changes |
| `full-bmad` | Architect | 2-4 | Features, components |
| `enterprise` | Analyst | 1-4 | Large systems, architecture |

## Session Management Scripts

After starting a session, use these scripts to manage it:

```bash
# Update current agent
./scripts/update-session agent "developer"

# Update phase
./scripts/update-session phase 3 "Implementation"

# Mark agent as completed
./scripts/update-session complete-agent "architect"

# Mark phase as completed
./scripts/update-session complete-phase 2

# Add output file
./scripts/update-session add-output "src/components/Button.tsx"

# Set session status
./scripts/update-session status "completed"

# Show current session
./scripts/update-session show
```

## Session File Location

The session state is stored at: `.ai-session/current.yaml`

## Integration with Commands

- `/progress` - reads from session file to show status
- `/handoff` - uses `update-session` to transition agents
- `/agent` - uses `update-session agent` to switch agents

## Your Job

When this command is called with: $ARGUMENTS

1. **Parse the arguments** to extract workflow, task, and optional project
2. **Run the script** using Bash tool:
   ```bash
   ./scripts/start-session <workflow> "<task>" [project]
   ```
3. **Verify** the session was created by checking output
4. **Display** the session info to the user
5. **Activate** the first agent and start working

**REMEMBER: Use Bash tool to run the script. Do not create files manually.**
