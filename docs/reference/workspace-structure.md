# Workspace Structure

```
lane/
├── .ai-config/              # Workspace configuration (from setup)
│   └── settings.yaml        # MCP services status
├── .ai-memory/              # Persistent memory (gitignored)
│   ├── audit/               # Tool use audit logs (YYYY-MM-DD.log)
│   ├── shared/              # AgentMemoryScope: team knowledge (git-tracked)
│   ├── local/               # AgentMemoryScope: personal state (gitignored)
│   ├── sessions/            # Session memory files (markdown + frontmatter)
│   ├── lessons/             # Manual lessons (global.yaml, <project>.yaml)
│   └── index.yaml           # Session memory index
├── .ai-session/             # Runtime session state
│   ├── by-id/               # Per-cc-session canonical state
│   │   ├── <sid>.yaml       # task/jira/project + agent state per session
│   │   │                    # (written by start-session when CLAUDE_SESSION_ID
│   │   │                    #  is bound; promoted from current.yaml on the
│   │   │                    #  first prompt otherwise)
│   │   └── <sid>.json       # per-prompt sidecar: task, jira_ticket, project,
│   │                        # cwd, prompts, lines_added/removed, lessons,
│   │                        # files (written by inject-context); plus
│   │                        # cost_usd, duration_ms, input/output/cache_*_tokens
│   │                        # backfilled by session-stop. See writeSidecar in
│   │                        # scripts/hooks/inject-context-impl.js for the
│   │                        # full schema.
│   ├── current.yaml         # Back-compat mirror of the most-recent session
│   ├── cc-session-id        # Current CC session id (written each session-start)
│   └── detected-project     # Session-id-gated project cache (lazy: only
│                            #  written when inject-context detects a project
│                            #  from cwd/skill/prompt)
│   # See docs/specs/spec-2026-05-15-per-cc-session-binding.md for the
│   # per-cc-session binding design.
├── .ai-contexts/            # Auto-generated project contexts
│   ├── <project>.yaml       # Project analysis + git config (per-project!)
│   └── epic-<KEY>.yaml      # Jira epic dependency graph
├── .claude/
│   ├── settings.json        # Hook configuration + agent teams env
│   ├── agents/              # Agent definitions for agent teams
│   │   ├── spec-writer.md       # Generates PRDs/specifications
│   │   ├── breakdown-planner.md # Spec → task breakdown with waves
│   │   └── implementer.md      # Focused implementation for agent teams
│   ├── commands/            # Slash commands
│   │   ├── spec.md              # /spec — Generate structured PRD
│   │   ├── breakdown.md         # /breakdown — Spec → implementation plan
│   │   ├── swarm-implement.md   # /swarm-implement — Execute plan with agent teams
│   │   └── ...                  # Other commands (work-ticket, agent, etc.)
│   └── visualizations/      # Generated dashboards
│       └── dashboard.html   # Self-improvement dashboard (npm run self:dashboard)
├── agent/
│   ├── _core/               # Orchestration system
│   │   ├── orchestrator.md      # Agent coordination
│   │   ├── agent-registry.md    # All agents catalog
│   │   ├── handoff-protocol.md  # Transition procedures
│   │   └── context-manager.md   # Context preservation
│   ├── _phases/             # Agent definitions
│   │   ├── 1-analysis/      # Analyst, Product Owner
│   │   ├── 2-planning/      # Architect, Designer, Tech Writer
│   │   ├── 3-implementation/# Developer, Tester, Reviewer
│   │   └── 4-delivery/      # Deployer, Documenter
│   └── _projects/           # ALL projects go here (symlinks OK)
│       └── [project-name]/
├── scripts/
│   ├── hooks/               # Claude Code hooks
│   │   ├── pre-tool-use.sh      # Blocks secrets, dangerous commands
│   │   ├── post-tool-use.sh     # Audit trail for file/bash operations
│   │   ├── inject-context.sh    # Injects manual lessons into prompts
│   │   ├── inject-rules.js      # Injects auto-learned rules (team + personal, project-scoped)
│   │   ├── context-budget.js    # Warns at 30+ prompts about context rot
│   │   └── value-logger.js      # Tracks rule injection events
│   ├── self-improvement/    # Automated learning system
│   │   ├── rules-shared.json    # Team rules (git-tracked, shared)
│   │   ├── rules.json           # Personal rules (gitignored, auto-extracted)
│   │   ├── config.json          # Learning thresholds and config
│   │   ├── promote-rules.ts     # Promote personal rules → team shared
│   │   ├── insight-extractor.ts # ExpeL: extract rules from sessions
│   │   ├── reflection-generator.ts # Reflexion: detect + analyze failures
│   │   ├── reinforcement-tracker.ts # Track rule usage, prune stale rules
│   │   ├── proposal-manager.ts  # Stage, review, apply rule proposals
│   │   ├── skill-generator.ts   # Auto-generate skills from novel sessions
│   │   ├── maintenance.ts       # Orchestrate full learning cycle
│   │   └── ...                  # Supporting modules
│   ├── session-embedder/    # Semantic search + dashboard
│   │   ├── dashboard-generator.ts   # Generate interactive dashboard
│   │   ├── dashboard-template.html  # Plotly dashboard template
│   │   ├── hybrid-search.ts    # Keyword + semantic combined search
│   │   ├── tiered-search.ts    # Multi-tier memory search
│   │   └── ...                 # Embedding, chunking, scoring modules
│   ├── shared/              # Shared utilities
│   │   ├── embedder.ts          # Local embeddings (bge-small-en-v1.5)
│   │   └── agent-memory-scope.ts # 3-scope memory with cross-agent transfer
│   ├── fresh-context        # Save context snapshot for clean session resume
│   ├── deep-map             # Deep codebase analysis (structure, deps, hot files, API, tests)
│   ├── wave-planner         # Group tasks into parallel execution waves
│   ├── learn-from-pr        # Extract rules from PR review comments
│   ├── snapshot-compare     # Before/after performance comparison
│   └── ...                  # Session mgmt, project mgmt, lesson scripts
├── docs/                    # Documentation
│   ├── ai-first.md          # AI-First Engineering Protocol
│   ├── specs/               # Generated specification documents (/spec output)
│   ├── plans/               # Generated implementation plans (/breakdown output)
│   └── reference/           # Technical reference docs
├── docker-compose.yml       # Qdrant vector DB (optional)
├── package.json             # npm scripts for self-improvement + search
└── tsconfig.json            # TypeScript config for scripts
```
