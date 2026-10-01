# Setup & Configuration

## First-Time Setup

```bash
./scripts/setup                 # Creates workspace structure, verifies MCP services
npm install                     # Install TypeScript + self-improvement dependencies
```

### Optional: Self-Improvement Infrastructure

```bash
docker compose up -d            # Start Qdrant vector DB
npm run session:embed           # Embed session logs for semantic search
npm run self:dashboard          # Generate interactive dashboard
```

Qdrant is optional. Team rules (`rules-shared.json`) work without it — they're injected via a lightweight JSON+keyword hook on every prompt. Qdrant enables: semantic session search, auto rule extraction from sessions, failure reflection analysis, and the interactive dashboard.

## Git Platform Configuration

**Git platform is configured per-project** (not globally). When you add a project, the platform is auto-detected:

```bash
./scripts/add-project https://bitbucket.org/mycompany/my-repo
# Auto-detects: Bitbucket, workspace "mycompany", default branch
```

Git configuration is stored in `.ai-contexts/<project>.yaml`:

```yaml
git:
  platform: "bitbucket"   # github, bitbucket, gitlab, azure, other
  cli: "curl"             # gh, glab, az, git, curl
  default_branch: "dev"
  workspace: "mycompany"  # Bitbucket only
```

**Different projects can use different git platforms** - work on Bitbucket in the morning, GitHub in the afternoon.

## Agent Teams Configuration

Agent teams allow Claude Code to spawn parallel sub-agents for implementation tasks. This is required for the `/swarm-implement` command.

**Enable agent teams** (already configured in `.claude/settings.json`):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

This enables the `spec-writer`, `breakdown-planner`, and `implementer` agents defined in `.claude/agents/`. The `/swarm-implement` command will check for this setting and prompt you to enable it if missing.

**Agent definitions** are in `.claude/agents/`:

| Agent | Purpose |
|-------|---------|
| `spec-writer` | Generates PRDs/specifications (used by `/spec`) |
| `breakdown-planner` | Spec to task breakdown with waves (used by `/breakdown`) |
| `implementer` | Focused implementation for parallel teams (used by `/swarm-implement`) |

## Project Discovery (MANDATORY)

**BEFORE starting any work**, always run:

```bash
./scripts/list-projects
```

This shows all available projects. If the target project is not listed:
- Ask the user to add it with `./scripts/add-project <name>` (new project)
- Or create a symlink: `ln -s /path/to/project agent/_projects/project-name` (existing project)
