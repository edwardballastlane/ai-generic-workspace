# Workspace Scripts Reference

**ALWAYS use these scripts - they ensure consistent state management.**

## Project Management

| Script | Command | When to Use |
|--------|---------|-------------|
| **list-projects** | `./scripts/list-projects` | **FIRST** - Before any task to discover projects |
| **add-project** | `./scripts/add-project <path-or-url>` | Add project (auto-detects git platform) |

## Project Context (Auto-Discovery Cache)

| Script | Command | When to Use |
|--------|---------|-------------|
| **generate-context** | `./scripts/generate-context <project>` | Generate project context with cached analysis |
| **validate-context** | `./scripts/validate-context <project>` | Check if context file is still valid |

**Context files are stored at workspace level:** `.ai-contexts/<project>.yaml`

This keeps external projects clean (important for symlinked repos).

**The context file caches:**
- **Git configuration** (platform, CLI, default branch, workspace)
- Tech stack (language, framework, UI library)
- Project structure (components, hooks, utils, services)
- UI component mapping (for Figma conversion)
- Developer instructions

**Usage:**
```bash
# Generate context for a project (auto-detects Node.js, Python, Go, .NET, etc.)
./scripts/generate-context prescriber-point
# Output: .ai-contexts/prescriber-point.yaml

# Context is auto-validated when starting a session
./scripts/start-session full-bmad "Add feature" my-project
# Output: "✓ Project context is valid" or auto-regenerates if stale
```

**Developer Agent:** Always check `.ai-contexts/<project>.yaml` FIRST before manual discovery!

## Session Management

| Script | Command | When to Use |
|--------|---------|-------------|
| **start-session** | `./scripts/start-session <workflow> "<task>" [project]` | Start workflow session |
| **update-session** | `./scripts/update-session <action> [args]` | Update session state |

**Session script actions:**
```bash
./scripts/update-session next-agent                 # Handoff: validates outputs + lessons, then moves to next
./scripts/update-session skip-agent                 # Skip current agent (no validation)
./scripts/update-session skip-to "deployer"         # Jump directly to specific agent (skips intermediate)
./scripts/update-session agent "developer"          # Switch agent (manual override only)
./scripts/update-session phase 3 "Implementation"   # Change phase
./scripts/update-session complete-agent "architect" # Mark agent done
./scripts/update-session complete-phase 2           # Mark phase done
./scripts/update-session add-output "file.tsx"      # Track output file
./scripts/update-session status "completed"         # End session
./scripts/update-session show                       # View session
```

### Example Workflow

```bash
# 1. Always start by listing projects
./scripts/list-projects

# 2. If project not found, add it (git platform auto-detected!)
./scripts/add-project ~/code/my-project              # Local project
./scripts/add-project https://github.com/user/repo   # GitHub
./scripts/add-project https://bitbucket.org/ws/repo  # Bitbucket

# 3. Start a session
./scripts/start-session full-bmad "Add dark mode" my-project

# 4. During handoffs, ALWAYS use next-agent to follow the sequence!
./scripts/update-session complete-agent "architect"
./scripts/update-session next-agent   # Automatically moves to "designer"
```

**CRITICAL**: Use the right handoff command for the situation:
- `next-agent` — Normal handoff (validates outputs + lessons before moving)
- `skip-agent` — Skip current agent when it's not needed (e.g., skip designer for backend work)
- `skip-to <agent>` — Jump directly to a specific agent (e.g., skip-to deployer after dev+test)
- **Full BMAD**: architect → designer → developer → tester → reviewer → deployer → documenter

**IMPORTANT:** Always use scripts for session management. Never create/edit `.ai-session/by-id/<sid>.yaml` or `.ai-session/current.yaml` manually. The scripts keep both in sync; manual edits break the per-cc-session invariant — see [docs/specs/spec-2026-05-15-per-cc-session-binding.md](../specs/spec-2026-05-15-per-cc-session-binding.md).

## Session Memory

| Script | Command | When to Use |
|--------|---------|-------------|
| **save-session-memory** | `./scripts/save-session-memory "summary"` | Save session to long-term memory after completing work |
| **search-memory** | `./scripts/search-memory "keyword"` | Search past sessions by keyword |
| **search-memory** | `./scripts/search-memory --project <name>` | Filter past sessions by project |
| **search-memory** | `./scripts/search-memory --recent 5` | Show last N sessions |

**How it works:**
- When a session is marked as `completed`, the system reminds you to save it to memory
- When starting a new session, past sessions for the same project are shown automatically
- Session memories are stored in `.ai-memory/sessions/` as markdown files with YAML frontmatter
- An index is maintained at `.ai-memory/index.yaml`

## Self-Learning (Automated Rules)

Rules are auto-extracted from sessions (ExpeL) and injected per-prompt via `inject-rules.js` (keyword-matched, top 5, score >= 3). New rules are auto-tagged with **projects** and **categories**.

**Rule flow:** ExpeL → `rules.json` (personal) → `npm run rules:promote-apply` → `rules-shared.json` (team)

| Command | Purpose |
|---------|---------|
| `npm run self:maintenance` | Full cycle: extract insights, reinforce, prune stale rules |
| `npm run self:stats` | Show rule statistics and reinforcement counts |
| `npm run self:dashboard` | Generate interactive HTML dashboard |
| `npm run self:review` | Review pending rule proposals |
| `npm run self:apply` | Apply approved proposals to rules.json |
| `npm run rules:promote` | Preview personal rules ready for team sharing (>= 15 reinforcements) |
| `npm run rules:promote-apply` | Promote to `rules-shared.json`, remove from `rules.json` |
| `npm run rules:effectiveness` | Score rule effectiveness (hit rate, reinforcement trends) |

**Files:** `rules.json` (personal, gitignored) · `rules-shared.json` (team, git-tracked) · `config.json`

**Dashboards:**
- `npm run self:dashboard` → `.claude/visualizations/dashboard.html` (rules, sessions, topics)
- `npm run tokens:dashboard` → `.claude/visualizations/token-dashboard.html` (token/cost tracking)

## Token Consumption Tracking

Session-level token usage and cost are captured by the `session-stop.sh` hook and stored in `.ai-memory/session-end-events.jsonl` (git-tracked for team-wide reports).

**Data captured per session:** input tokens, output tokens, cache read/creation tokens, cost USD, duration, prompts, user (git), project.

Events are sharded per month (`session-end-events-YYYY-MM.jsonl`) once the log grows; every reader goes through `scripts/_lib/session-events.js` rather than hardcoding a path. Set `LANE_EVENTS_ROOT` when sessions run from other repos so they all log into one canonical clone (see [spec-2026-06-24-centralized-session-logging.md](../specs/spec-2026-06-24-centralized-session-logging.md)).

| Command | Purpose |
|---------|---------|
| `npm run tokens:dashboard` | Generate interactive HTML dashboard with date filters |
| `npm run tokens:data` | Generate JSON data only (for CI/custom reports) |
| `npm run cost:admin` | Pull the *actual billed* cost from Anthropic's Admin Cost Report API into `.ai-memory/admin-cost-<month>.json` (needs `ANTHROPIC_ADMIN_KEY`). List-price vs metered: [cost-accuracy.md](cost-accuracy.md) |
| `npm run dashboard:combine` | Merge the token + self-improvement dashboards into one `index.html` with a view toggle (picks up an optional `roadmap.html` as a third view) |
| `npm run self:dashboard:publish` | Regenerate the self-improvement dashboard from full local data and commit the snapshot so CI/teammates get it |
| `npm run jira:refresh-period` | Cache the delivered-ticket universe for the dashboard's delivery/coverage sections |

**Team attribution.** Two optional committed maps fold identity variants onto one person: `.ai-memory/user-aliases.json` (git `user.name` variants → canonical user; `./scripts/backfill-user-aliases.js` rewrites history in place) and `.ai-memory/team-aliases.json` (Jira display-name variants → roster name). The salary-free roster lives in `.ai-memory/team-roster.json`; `scripts/_lib/team-config.js` falls back to a local `.claude/commands/team-report.md` when the JSON is absent.

**Dashboard filters:** All Time, YTD, MTD, Last 7d, Last 30d, and a month picker.

**How it works:**
1. `session-stop.sh` reads the Claude transcript to compute token totals at session end
2. Writes enriched event (tokens + cost + user + project) to `session-end-events.jsonl`
3. `statusline` also persists live token counts into the session sidecar on each render
4. `npm run tokens:dashboard` aggregates all events into an HTML dashboard

### Per-Claude-Code-Instance Sidecar

Each Claude Code session (terminal window / IDE instance) gets its own sidecar at `.ai-session/by-id/<session_id>.json`, maintained by `inject-context.sh` on every prompt. Multi-terminal safe (no shared file contention).

| Script | Command | When to Use |
|--------|---------|-------------|
| **session-stats** | `./scripts/session-stats [--all\|--session-id <id>\|--json]` | Report prompts, cost, files touched, idle time |
| **statusline** | (wired via `.claude/settings.json`) | UI status line — zero token cost |
| **set-ai-estimate** | `./scripts/set-ai-estimate.js --ticket PROJ-1234 --ai-sp 3 --basis create\|post-plan [--estimator <id>]` (bash/cmd stubs) | Record AI estimate to `.ai-memory/ai-estimates.json` cache; enables dashboard accuracy and throughput metrics |
| **agent-router** | `require('./scripts/agent-router')` | Tiered model routing for spawned agents/teammates — keeps mechanical subtasks off the top-tier model |
| **remove-project** | `./scripts/remove-project <name>` | Inverse of `add-project`: drops the symlink, context cache, and workspace-file entry |

Sidecar fields: `session_id`, `started_at`, `last_active`, `cwd`, `project`, `prompts`, `cost_usd`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `lines_added`, `lines_removed`, `files_touched`. Auto-pruned after 7 days of inactivity.

## Code Quality Hooks

Claude Code hooks are configured in `.claude/settings.json` and run automatically:

| Hook | Trigger | What it Does |
|------|---------|-------------|
| **pre-tool-use.sh** | Before Bash/Write/Edit | Blocks hardcoded secrets, `git push --force` to main, `rm -rf /` |
| **post-tool-use.sh** | After Bash/Write/Edit | Audit trail only (zero stdout) |
| **inject-context.sh** | On every user prompt | Project detection, sidecar tracking, project context injection |
| **inject-rules.js** | On every user prompt | Injects top 5 auto-learned rules (score >= 3, project-boosted +3, keyword matched) |
| **context-budget.js** | On every user prompt | Warns at 30+ prompts about context rot; suggests `./scripts/fresh-context` |
| **session-start.sh** | On session start | Placeholder (previously synced rules to native memory, now disabled) |
| **session-stop.sh** | On session stop | Computes token totals from transcript, logs enriched event with tokens/cost/user/project |
| **subagent-stop.sh** | On subagent stop | Logs subagent events for analysis |
| **pre-compact.sh** | Before CC compacts context | Auto-saves fresh-context snapshot so state survives compaction |
| **notify.sh** | On notifications | Logs notification events |
| **value-logger.js** | (utility) | Tracks rule injection events for effectiveness scoring |

**Audit logs** are at `.ai-memory/audit/YYYY-MM-DD.log` (append-only, one file per day).

## Codebase Analysis & Planning

| Script | Command | When to Use |
|--------|---------|-------------|
| **deep-map** | `./scripts/deep-map <project>` | Deep codebase analysis (structure, deps, hot files, API surface, tests, patterns). Output: `.ai-contexts/<project>-deep-map.md` |
| **wave-planner** | `./scripts/wave-planner <EPIC-KEY>` | Group tasks into parallel execution waves. Accepts epic key or piped task list. Options: `--compact`, `--json`, `--detect-order` |
| **fresh-context** | `./scripts/fresh-context [note] [--print\|--latest\|--session-id <id>]` | Save paste-ready handoff prompt for resuming in a new session. Reads sidecar + workflow + git state. Output: `.ai-session/resume/latest.md` |
| **snapshot-compare** | `./scripts/snapshot-compare before\|after\|status <project>` | Before/after performance comparison. Auto-captures reflection if regression exceeds thresholds |
| **learn-from-pr** | `./scripts/learn-from-pr [--apply] <PR#\|URL>` | Extract learning rules from PR review comments. Default: dry-run. Use `--apply` to save to `rules.json` |

## Slash Commands (Claude Code)

| Command | Purpose | Agent |
|---------|---------|-------|
| `/spec "task"` | Generate a structured PRD/specification | `spec-writer` |
| `/breakdown <spec-file>` | Spec to implementation plan with dependency-aware task waves | `breakdown-planner` |
| `/swarm-implement <plan>` | Execute plan using Claude Code agent teams (parallel teammates) | `implementer` (x N) |

**Spec/Plan pipeline:** `/spec` produces a spec in `docs/specs/`, `/breakdown` produces a plan in `docs/plans/`, `/swarm-implement` executes the plan with parallel agent teams.

## Agent Definitions (.claude/agents/)

| Agent | File | Purpose |
|-------|------|---------|
| **spec-writer** | `.claude/agents/spec-writer.md` | Generates PRDs with goals, non-goals, acceptance criteria, API contracts, data models, risks |
| **breakdown-planner** | `.claude/agents/breakdown-planner.md` | Takes a spec and produces dependency-aware task breakdown with wave-based parallel execution |
| **implementer** | `.claude/agents/implementer.md` | Focused implementation agent for agent teams. Claims tasks from shared list and implements them |

## Self-Improvement System (Automated Rules)

The self-improvement system auto-extracts rules from AI sessions and injects them into future prompts. Rules are managed via two files:

- **`rules-shared.json`** — Team rules, git-tracked. Every developer gets these on `git pull`.
- **`rules.json`** — Personal rules, gitignored. Auto-extracted from your sessions.

### Setup (one-time, optional)

```bash
npm install                   # Install TypeScript + dependencies
docker compose up -d          # Start Qdrant (for semantic search + rule extraction)
```

### Daily Commands

| Command | Purpose | Requires Qdrant? |
|---------|---------|-------------------|
| `npm run self:stats` | Show rule statistics and reinforcement counts | No |
| `npm run self:dashboard` | Generate interactive HTML dashboard | Yes |
| `npm run rules:promote` | Preview personal rules ready for team sharing | No |
| `npm run rules:promote-apply` | Promote personal rules to `rules-shared.json` | No |

### Periodic Maintenance

| Command | Purpose | Requires Qdrant? |
|---------|---------|-------------------|
| `npm run self:maintenance` | Full cycle: extract insights, reinforce, prune | Yes |
| `npm run self:extract-insights` | Extract rules from high/low quality sessions | Yes |
| `npm run self:generate-reflections` | Detect session failures, generate reflections | Yes |
| `npm run self:prune` | Remove stale rules (60 days without reinforcement) | No |
| `npm run self:review` | Review pending rule proposals | No |
| `npm run self:apply` | Apply approved proposals to rules.json | No |

### Session Search

| Command | Purpose | Requires Qdrant? |
|---------|---------|-------------------|
| `npm run session:embed` | Embed session logs into Qdrant for search | Yes |
| `npm run session:search` | Semantic search across past sessions | Yes |
| `npm run hybrid:search` | Combined keyword + semantic search | Yes |
| `npm run tiered:search` | Multi-tier memory search (working/episodic/semantic) | Yes |
| `npm run session:stats` | Embedding statistics | Yes |
| `npm run session:score` | Score session quality (for rule extraction weighting) | Yes |

### Agent Memory Scopes

3-scope memory system for cross-agent knowledge transfer:

| Scope | Location | Git-tracked? | Purpose |
|-------|----------|-------------|---------|
| **project** | `.ai-memory/shared/` | Yes | Team knowledge (shared via git) |
| **local** | `.ai-memory/local/` | No | Personal workspace state |
| **user** | `~/.lane-memory/` | No | Global across all workspaces |

| Command | Purpose |
|---------|---------|
| `npm run memory:stats` | Show memory stats across all scopes |
| `npm run memory:list -- project` | List entries in a scope |
| `npm run memory:search -- "query"` | Search across all scopes |
| `npm run memory:transfer -- project user 0.8` | Transfer high-confidence knowledge between scopes |

### Qdrant Seeding & Effectiveness

| Command | Purpose | Requires Qdrant? |
|---------|---------|-------------------|
| `npm run qdrant:seed` | Seed team rules into Qdrant (for new dev onboarding) | Yes |
| `npm run qdrant:status` | Show Qdrant seeding status | Yes |
| `npm run rules:effectiveness` | Score rule effectiveness (hit rate, reinforcement trends) | No |

### Sharing Rules with the Team

```bash
# 1. Review which personal rules are ready for team sharing
npm run rules:promote

# 2. Apply promotion (moves to rules-shared.json, removes from rules.json)
npm run rules:promote-apply

# 3. Commit and push
git add scripts/self-improvement/rules-shared.json
git commit -m "chore: promote learned rules to team shared set"
git push
```

Promotion **moves** rules from personal to shared (not copy). Dedup ensures rules already in shared won't be re-extracted by ExpeL. Team members receive the rules on `git pull` — no Qdrant or Docker required.
