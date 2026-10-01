# Edward Bocaranda Challenges Public Repo

# Lane 🛤️

> A lightweight, phase-based AI workspace for software development inspired by the BMAD methodology

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Context7%20%2B%20Figma-green.svg)](docs/03-MCP-SETUP.md)
[![Methodology](https://img.shields.io/badge/Methodology-BMAD-orange.svg)](METHODOLOGY.md)

## What is Lane?

Lane is a **technology-agnostic workspace** that organizes AI-assisted software development into **4 clear phases**:

```
Analysis → Planning → Implementation → Delivery
```

Unlike complex, domain-specific tools, Lane is:
- ✨ **Minimal** - Only essential MCP services pre-configured
- 🚀 **Fast** - Setup in under 2 minutes, ready to use immediately
- 📚 **Educational** - Learn AI-assisted development
- 🔧 **Flexible** - Adapt to any tech stack
- 🧠 **Self-Learning** - Extracts rules from sessions and improves over time

## Quick Start

```bash
# Clone repository (replace <your-org>/<your-workspace> with your fork)
git clone git@bitbucket.org:<your-org>/<your-workspace>.git
cd <your-workspace>

# Run setup (REQUIRED — interactive prompts for Jira prefix, workspace name, project)
./scripts/setup

# Copy the env template and fill in the values you need
cp .env.example .env && chmod 600 .env
# (Edit .env to add ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN, AWS keys, etc.)

# Start Claude Code
claude

# Start working — MCP services are pre-configured
/work-ticket "Your task here"
```

**Setup prompts you for:**
- **Jira ticket prefix** (e.g. `PROJ`) — used to extract ticket IDs from prompts and commit messages. Leave blank to disable.
- **Workspace name** — used as a prefix for AWS resources created by the optional token dashboard infra.
- **First project** — optionally add your first project (existing path, Git URL, or new empty project).

**Optional: token-consumption dashboard.** Once you have AWS credentials in `.env`, run `npm run tokens:setup` to provision an S3 + CloudFront site, then `npm run tokens:deploy` to push the dashboard. `npm run tokens:teardown` cleans it up. See [`infra/token-dashboard/`](infra/token-dashboard/) for details.

## The 4 Development Phases

### 🔍 Phase 1: Analysis
**Research and discover** - Understand requirements and gather information
- **Agents**: Analyst, Product Owner
- **Output**: Requirements docs, user stories

### 🏗️ Phase 2: Planning
**Design and architect** - Create technical and visual specifications
- **Agents**: Architect, Designer, Tech Writer
- **Tools**: Figma integration for design
- **Output**: Tech specs, designs, doc plans

### 💻 Phase 3: Implementation
**Build and test** - Write code and ensure quality
- **Agents**: Developer, Tester, Reviewer
- **Tools**: Context7 for up-to-date docs
- **Output**: Working code, tests

### 🚀 Phase 4: Delivery
**Deploy and document** - Ship to production
- **Agents**: Deployer, Documenter
- **Output**: Deployed app, final documentation

## 3 Workflow Speeds

Choose the right workflow for your task:

| Workflow | Time | Use Case | Phases |
|----------|------|----------|--------|
| **Quick Flow** | 5 min | Bug fixes, small changes | Implementation → Delivery |
| **Full BMAD** | 15 min | Features, components | Planning → Implementation → Delivery |
| **Enterprise** | 30 min | Large systems | Analysis → Planning → Implementation → Delivery |

## Smart Workflow Router

Let AI decide the best workflow:

```bash
/work-ticket "Fix login bug"           # → Quick Flow
/work-ticket "Add user dashboard"      # → Full BMAD
/work-ticket "Enterprise API gateway"  # → Enterprise Flow
```

## Jira Epic & PRD Support

Work on epics with proper branch chaining:

```bash
# From Jira - fetches epic and builds task dependency chain
/jira-epic PPT-6691

# From PRD - paste document or reference file
/jira-epic docs/feature-prd.md

# Resume work on any epic
/work-ticket --epic PPT-6691
```

**Branch Chain Model**: Each PR targets its blocker's branch for clean merges:
```
Epic: PROJ-100
├── PROJ-1234 (no blockers)     → PR to: dev
├── PROJ-1235 (blocked by 1234) → PR to: PROJ-1234
└── PROJ-1236 (blocked by 1235) → PR to: PROJ-1235
```

## Spec-Driven Development

Generate structured specs, break them into parallel task waves, and execute with agent teams:

```bash
# Generate a structured PRD/spec
/spec "Add user authentication with OAuth"

# Break a spec into dependency-aware task waves
/breakdown docs/specs/auth-spec.md

# Execute plan using parallel agent teams
/swarm-implement docs/plans/auth-plan.md
```

**Agent Teams** run independent tasks in parallel waves — each wave executes concurrently, the next wave starts only after all tasks in the current wave complete.

## Self-Improvement System

Lane learns from every session using an ExpeL-based rule extraction engine:

```bash
npm run self:maintenance   # Full cycle: extract, reinforce, prune stale rules
npm run self:stats         # Show rule statistics and reinforcement counts
npm run self:review        # Review pending rule proposals
npm run self:apply         # Apply approved proposals to rules.json
npm run self:dashboard     # Generate interactive HTML dashboard
```

**Rules are automatically injected** on every prompt via hooks — keyword-matched, top 5–8 rules per context.

**Team rule sharing:**
```bash
npm run rules:promote       # Preview personal rules ready for team sharing
npm run rules:promote-apply # Promote to rules-shared.json (git-tracked)
# Then: git add/commit/push rules-shared.json — team gets rules on git pull
```

**Memory scopes** (project / local / user) with cross-agent transfer:
```bash
npx ts-node scripts/shared/agent-memory-scope.ts stats
```

## Analysis & Reliability Tools

### Codebase Analysis
```bash
./scripts/deep-map <project>   # Deep analysis: structure, deps, hot files, API, tests, patterns
./scripts/fresh-context        # Save context snapshot for clean session resume
```

### Wave-Based Task Planning
```bash
./scripts/wave-planner <EPIC-KEY>   # Group tasks into dependency-aware parallel execution waves
```

### Performance Snapshots
```bash
./scripts/snapshot-before <project>          # Capture baseline
./scripts/snapshot-after <project>           # Capture after changes
./scripts/snapshot-compare before|after <project>  # Diff performance regression
```

### Bug Hunting
```bash
/bug-hunt                        # Fetch Datadog errors, analyze root causes, open draft PRs
./scripts/dd-bug-hunter          # Standalone Datadog bug hunter script
./scripts/learn-from-pr <PR#>    # Extract reusable rules from PR review comments
```

The **reliability-hunter** agent autonomously fetches Datadog errors, identifies root causes across the codebase, creates fix branches, and opens draft PRs.

### Quality Gate
```bash
./scripts/quality-gate   # Unified runner: pre-commit, pre-pr, and CI stages
```

## Semantic Session Search

Sessions are embedded into a vector store for semantic search and pattern retrieval:

```bash
npm run session:embed    # Embed session logs for semantic search
npm run session:search   # Search sessions semantically
npm run hybrid:search    # Combined keyword + semantic search
npm run rules:effectiveness  # Score rule effectiveness (hit rate, reinforcement trends)
npm run qdrant:seed      # Seed team rules into Qdrant (for new dev onboarding)
```

Requires Qdrant (optional): `docker compose up -d`

## Core Features

### 🎯 Specialized Agents
Each agent is an expert in their domain:
- **Planning**: Analyst, Product Owner, Architect, Designer, Tech Writer
- **Implementation**: Developer, Tester, Reviewer
- **Delivery**: Deployer, Documenter
- **Spec pipeline**: Spec Writer, Breakdown Planner, Implementer
- **Reliability**: Reliability Hunter

### 🔌 Pre-Configured MCP Services
Powerful services ready to use out-of-the-box:

**Context7** - Access up-to-date documentation
- Get latest framework docs (React, Vue, Next.js, etc.)
- Find API references and best practices
- See real-world code examples

**Figma** - Design integration via SSE
- Review designs in real-time
- Extract component specs
- Generate code from design files

**Playwright** - Browser automation
- Test web applications
- Automate workflows
- Take screenshots and snapshots

**Sequential Thinking** - Advanced reasoning
- Break down complex problems
- Multi-step analysis and planning
- Iterative problem-solving

**Atlassian** - Jira & Confluence integration
- Fetch epics and issues
- Build dependency chains
- Read issue details and status

**Datadog** - Observability & error tracking
- Search and aggregate logs
- Monitor dashboards and incidents
- Power the reliability-hunter workflow

**AWS CloudWatch** - Cloud monitoring
- Query log groups with Insights
- Retrieve metrics and active alarms
- Cross-region operational awareness

**AWS Lambda** - Serverless function management
- Invoke and monitor Lambda functions
- Inspect function configurations

**Agent Vibes** - Additional AI agent capabilities

### 📊 Scale-Adaptive Intelligence
The system adjusts to your needs:
- Small tasks → Quick execution
- Medium features → Balanced approach
- Large systems → Comprehensive planning

### 🧩 Phase-Based Organization
No more confusion about which agent to use:
```
Need to design? → Planning Phase → Designer agent
Need to code? → Implementation Phase → Developer agent
Need to deploy? → Delivery Phase → Deployer agent
```

### 🧠 Self-Learning Layer
Lane learns from your sessions and re-injects what works into future prompts:
- **ExpeL rule extraction**: post-session insights are scored and queued as proposals
- **Hook-driven injection**: top-N rules matched by keyword + Qdrant semantics land in every prompt
- **Promotion pipeline**: personal rules graduate to a team-shared file once they cross a reinforcement threshold
- **Token-consumption dashboard**: optional S3 + CloudFront site showing token spend per user/project (`infra/token-dashboard/`)

## VS Code Workspace

You can adapt `lane.code-workspace` (if present in your fork) into a multi-root workspace:
- Direct relative paths (not symlinks) so VS Code search works across all folders
- `search.useIgnoreFiles: false` ensures full-text search isn't blocked by `.gitignore`
- Auto-updated when you add a project via `./scripts/add-project`

## Documentation

Core documentation files:
- 📖 [README.md](README.md) - This file, overview and quick start
- 🎯 [METHODOLOGY.md](METHODOLOGY.md) - BMAD methodology and workflows
- 🤖 [CLAUDE.md](CLAUDE.md) - Instructions for Claude AI
- 📝 [MARKDOWN_GUIDE.md](MARKDOWN_GUIDE.md) - Documentation standards
- 📋 [Agent Registry](agent/_core/agent-registry.md) - All available agents
- 🔄 [Orchestrator](agent/_core/orchestrator.md) - Agent coordination

## MCP Configuration

The workspace includes a pre-configured [.mcp.json](.mcp.json) with essential services:

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "figma": { "type": "sse", "url": "http://127.0.0.1:3845/sse" },
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "sequential-thinking": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
    "atlassian": { "command": "mcp-remote", "args": ["https://mcp.atlassian.com/v1/sse", "-y"] },
    "datadog": { "command": "npx", "args": ["-y", "datadog-mcp-server"] },
    "aws-cloudwatch": { "command": "uvx", "args": ["awslabs.cloudwatch-mcp-server"] },
    "aws-lambda": { "command": "uvx", "args": ["awslabs.lambda-mcp-server"] }
  }
}
```

To learn more about the MCP configuration, run: `./scripts/setup --info`

## Why Lane?

### vs. Other AI Tools

| Feature | Lane | Other Tools |
|---------|------|-------------|
| Setup Time | 2 minutes | Hours |
| Learning Curve | Gentle | Steep |
| MCP Services | 9 pre-configured | Manual setup required |
| Self-Learning | Yes (ExpeL rules) | No |
| Spec Pipeline | Yes (/spec, /breakdown, /swarm-implement) | No |
| Domain Focus | General purpose | Often specialized |
| Methodology | BMAD phases | Various/unclear |

### Philosophy

1. **Simplicity First** - Only essential tools
2. **Phase-Based** - Clear workflow structure
3. **Educational** - Learn as you build
4. **Flexible** - Adapt to any stack
5. **Self-Improving** - Gets smarter every session
6. **Community-Driven** - Open source and extensible

## Requirements

- Node.js 18+ (for running MCP services and self-improvement scripts)
- Git
- Claude Code CLI or VSCode with Claude Code extension
- Docker (optional, for Qdrant semantic search)

**Note**: MCP services are pre-configured in [.mcp.json](.mcp.json). No additional accounts or setup required to get started!

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by [BMAD Methodology](https://github.com/bmad-code-org/BMAD-METHOD)
- Built with [Claude Code](https://docs.anthropic.com/claude-code)
- MCP servers: [Context7](https://context7.com), [Figma](https://github.com/figma/mcp-server), [Playwright](https://playwright.dev/), [Sequential Thinking](https://github.com/modelcontextprotocol/servers), [Datadog](https://www.datadoghq.com/), [AWS CloudWatch](https://aws.amazon.com/cloudwatch/)

---

**Ready to build with AI?** Run `./scripts/setup` and start with `/work-ticket "Your task"` →
