# Lane - Claude Instructions

This workspace uses a **phase-based development methodology** inspired by BMAD.

## Critical Rules

**ALWAYS follow these rules:**

1. **Project Discovery FIRST**: Before ANY task, run `./scripts/list-projects` to see available projects
2. **Project Location**: ALL projects MUST be in `agent/_projects/` - NEVER in the root or other locations
3. **Projects as Symlinks**: When adding external projects, ALWAYS create symlinks (e.g., `ln -s /path/to/project agent/_projects/project-name`) - NEVER copy files
4. **Agent Files**: All agent definitions are in `agent/_phases/` - do not modify structure
5. **Core Files**: The `agent/_core/` directory contains orchestration logic - reference but don't modify without explicit request
6. **Documentation**: Always update docs when making structural changes
7. **ASK BRANCH BEFORE COMMITS**: ALWAYS ask the user for branch name AND base branch (e.g., `dev`, `main`) BEFORE creating any commits or PRs. NEVER assume branch names.
8. **DISCOVER PR FORMAT**: Before creating any PR, check merged PRs to discover the repository's PR format. Copy the structure, sections, and style from existing merged PRs. NEVER use a generic format.
9. **CHECK PROJECT GIT CONFIG**: Read `.ai-contexts/<project>.yaml` for git platform (GitHub, Bitbucket, GitLab, Azure) - each project can have different git platforms
10. **AUTO-DETECT WORKFLOW**: When the user provides an actionable task (e.g., "add feature X", "fix bug Y") without explicitly running `/work-ticket`, automatically detect the appropriate workflow and start it. Treat any actionable task as an implicit `/work-ticket`. Skip for purely conversational messages or explicit commands.
11. **STORY POINT TICKETS**: When creating Jira tickets or when asked to estimate/story-point a ticket, use `/story-point` to assign accurate estimates anchored against calibrated real examples. Always read the calibration file before estimating.

## Your Role

You are working within the Lane workspace. Select the appropriate agent based on the current phase and task.

## Phase System

| Phase | Agents | Purpose | Entry |
|-------|--------|---------|-------|
| 1 - Analysis | Analyst, Product Owner | Research & requirements | `/analyze "task"` |
| 2 - Planning | Architect, Designer, Tech Writer | Design & specification | `/plan "task"` |
| 3 - Implementation | Developer, Tester, Reviewer | Code & testing | `/implement "task"` |
| 4 - Delivery | Deployer, Documenter | Deployment & documentation | `/deliver "task"` |

## Key Commands

| Command | Purpose |
|---------|---------|
| `/work-ticket "task"` | Start workflow (auto-routes: Quick/Full BMAD/Enterprise) |
| `/spec "task"` | Generate structured PRD/specification |
| `/breakdown <spec-file>` | Spec → task breakdown with wave-based execution plan |
| `/swarm-implement <plan>` | Execute plan using agent teams (parallel teammates) |
| `/jira-epic <KEY>` | Analyze Jira epic with branch chain |
| `/agent [name]` | Switch to specific agent |
| `/handoff` | Manual transition to next agent (rarely needed) |
| `/progress` | View current workflow status |

## Automatic Handoffs

**Handoffs happen AUTOMATICALLY.** When you complete work as one agent:

1. **Display** the handoff summary (visible in conversation)
2. **Immediately become** the next agent (no user action needed)
3. **Continue working** as the new agent

**NEVER ask the user to run `/handoff` manually.** The workflow should flow continuously:
`Architect → Handoff Summary → Designer → Handoff Summary → Developer → ...`

The `/handoff` command exists only for manual intervention if needed.

## Session Management

The workflow tracks state in two places:

- `.ai-session/by-id/<claude_session_id>.yaml` — **canonical per-cc-session task binding** (Phase B, 2026-05-15). Each CC session has its own file, so parallel terminals never overwrite each other.
- `.ai-session/current.yaml` — back-compat shim that mirrors whichever per-session yaml was most recently written. Tools that don't know the active session id (e.g., `./scripts/list-projects` from a non-CC shell) read this.

**Always use scripts** — never edit session files manually. `start-session` writes both files; `update-session` reads `$CLAUDE_SESSION_ID` (or falls back to `current.yaml.claude_session_id`) to target the right per-session yaml, and mirrors the result back to `current.yaml` on exit.

See [docs/specs/spec-2026-05-15-per-cc-session-binding.md](docs/specs/spec-2026-05-15-per-cc-session-binding.md) for the full design rationale.

**Key scripts:** `./scripts/start-session`, `./scripts/update-session` (see [docs/reference/scripts.md](docs/reference/scripts.md) for all actions)

**Handoff commands:**
- `next-agent` — Normal handoff (validates outputs + lessons before moving)
- `skip-agent` — Skip current agent when not needed
- `skip-to <agent>` — Jump directly to a specific agent
- **Full BMAD sequence**: architect → designer → developer → tester → reviewer → deployer → documenter

## Self-Learning (Automated Rules)

Rules are auto-extracted from sessions (ExpeL) and injected via hook on every prompt (keyword-matched, top 5 per prompt, score >= 3). This is the **single learning system** — no manual lesson capture needed.

**Rule flow:** ExpeL extracts → `rules.json` (personal) → `npm run rules:promote-apply` → `rules-shared.json` (team, git-tracked)

New rules are auto-tagged with **project** and **categories** based on keyword detection. The prompt hook scores rules with Jaccard similarity on stopword-filtered tokens, boosts project-tagged rules by `+0.03` when the active project matches, and falls back to a file-cached semantic match (local brute-force cosine over rule embeddings — no Qdrant) when lexical scoring is thin. Full pipeline: [docs/architecture/prompt-hook-learning-system.md](docs/architecture/prompt-hook-learning-system.md).

| Command | Purpose |
|---------|---------|
| `npm run self:maintenance` | Full cycle: extract insights, reinforce, consolidate (merge near-duplicate / demote contradicted), prune stale rules |
| `npm run self:consolidate` | Consolidate active rules: merge near-duplicates (deterministic absorb) and demote contradicted ones (`--dry-run` to preview) |
| `npm run self:stats` | Show rule statistics and reinforcement counts |
| `npm run self:review` | Review pending rule proposals |
| `npm run self:apply` | Apply approved proposals to rules.json |
| `npm run self:dashboard` | Generate interactive HTML dashboard |
| `npm run session:embed` | Embed session logs for semantic search |
| `npm run session:search` | Search sessions semantically |
| `npm run hybrid:search` | Combined keyword + semantic search |
| `npm run rules:effectiveness` | Score rule effectiveness (hit rate, reinforcement trends) |
| `npm run rules:stats` | Live rule-injection stats: top/stale/never-fired, category mix, lexical vs semantic |
| `npm run rules:stats:json` | Same stats as JSON (for tooling) |
| `npm run qdrant:seed` | Seed team rules into Qdrant (for new dev onboarding) |

**Rule sharing (promotion):**
| Command | Purpose |
|---------|---------|
| `npm run rules:promote` | Preview personal rules ready for team sharing (>= 15 reinforcements) |
| `npm run rules:promote-apply` | Promote to `rules-shared.json` and remove from `rules.json` |

Then `git add/commit/push rules-shared.json` — team gets rules on `git pull`.

**Memory-save proposals (Stop hook → review queue):**

The `Stop` hook scans each transcript for explicit save-intent turns ("save to memory", "remember this", "note for later") and appends them to `.ai-memory/memory-proposals.jsonl` paired with the preceding assistant turn. Nothing writes to `MEMORY.md` without review. Opt-out: `MEMORY_SYNC_ENABLED=0`.

| Command | Purpose |
|---------|---------|
| `npm run memory:review` | Walk pending proposals, accept/reject/skip interactively; accepted entries land in `memory/<slug>.md` + MEMORY.md index |
| `npm run memory:review:list` | Non-interactive list of all proposals (pending/accepted/dismissed) |
| `npm run memory:review:prune` | Drop dismissed/accepted entries older than 14 days |

**Lane memory (observation store + team sharing):**

A typed observation store the agent reads and writes over MCP (`lane-memory`, registered in
`.mcp.json`). Distinct from the rules system above: rules are injected every prompt, observations
are *recalled on demand* via `mem_search`. Locally-authored observations auto-export on session
end and auto-import on session start, so team memory travels with `git pull`.

| Command | Purpose |
|---------|---------|
| `npm run memory:setup` | One-time: register the MCP server and print next steps |
| `npm run memory:mcp` | Run the `lane-memory` MCP server (stdio) |
| `npm run memory:migrate` | Seed the store from `rules-shared.json` + `MEMORY.md` (`:dry` to preview) |
| `npm run memory:export` / `memory:import` | Publish / ingest team observation chunks |
| `npm run memory:board` | Team Memory Board HTML (local-only) |
| `npm run memory:stow` | Tiered decay pass — retire stale observations to a cold archive (`:dry` to preview) |
| `npm run memory:prune-noise` | Drop noise summaries + sensitive observations, backfill projects (`:dry` to preview) |

**Sensitive-data gate:** what counts as sensitive is a property of the project, so the patterns
live in `.ai-memory/memory-policy.json` (`sensitivePatterns` / `exemptPatterns`). With no policy
file nothing is gated. See [docs/reference/memory-protocol.md](docs/reference/memory-protocol.md).

**Evidence & verification gates:**

A "done" claim should cite machine evidence, not a model assertion. `record-evidence` captures a
command's output, hashes it, and ties it to one acceptance criterion; `verify-evidence` re-checks
the hash, the exit code, **and** that the claimed assertion is present — so a hollow green (exit 0,
0 tests collected) is rejected. `gate-theater` flags a verifier panel that has degraded into
rubber-stamping.

| Command | Purpose |
|---------|---------|
| `npm run evidence:record -- --task <id> --criterion <id> --assert <substr> -- <cmd>` | Run a command, capture + hash its output as evidence |
| `npm run evidence:verify -- [--task <id>]` | Re-verify recorded evidence (exit 1 on tamper / hollow green) |
| `npm run verification:record -- --task <id> --mode local\|staging --verdict PASS\|FAIL` | Record a verification outcome + mark the session sidecar |
| `npm run verify:gate -- [repoRoot]` | Run the repo's `.lane-verify.json` commands and record a verdict |
| `npm run rules:gate-theater` | Report approval-rate / never-fails theater across recorded verdicts |

The verify gate is **opt-in per repo**: with no `.lane-verify.json` it no-ops. `session-stop`
spawns it detached over the files a session touched (`VERIFY_GATE_ENABLED=0` to disable), and
`post-tool-use` records a verdict when a PR-create command runs. Specs:
[evidence-based completion](docs/specs/spec-2026-08-03-evidence-based-completion.md),
[anti-rubber-stamp gate](docs/specs/spec-2026-08-03-anti-rubber-stamp-gate.md).

**Ratchets (monotonic quality guards):**

Each ratchet freezes the *current* population of a problem and fails only on **growth**, so a
repo adopts the guard immediately without a cleanup project first. Run in CI on every PR and
on the default branch, and by the verify gate.

| Command | Guards against |
|---------|----------------|
| `npm run ratchet:all` | All four (what CI runs) |
| `npm run ratchet:deadcode` | New script files nothing references |
| `npm run ratchet:guard` | A security guard in `pre-tool-use.js` silently changing or disappearing |
| `npm run ratchet:refusal` | A hook refusal that names no next step ("dead-end refusal") |
| `npm run ratchet:retired` | A deprecated term reappearing in active source |

Add `--update` to re-freeze a baseline after a deliberate change; `--json` for tooling.
Baselines (`.deadcode-baseline.txt`, `.guard-population-baseline.txt`,
`.refusal-ratchet-baseline.txt`) and the term list (`.retired-terms.txt`) are committed —
they describe **this** codebase and are never copied between workspaces.

Guards are registered by a `// guard:population <name> <fail-closed|too-tight|too-loose>: <rationale>`
comment above the check; a refusal that cannot name a next step needs
`// refusal:by-design <human-authority|world-action|operator-knowledge|environment>`.

**Token consumption tracking:**
| Command | Purpose |
|---------|---------|
| `npm run tokens:dashboard` | Generate team token/cost dashboard (HTML, filterable by YTD/MTD/month) |
| `npm run tokens:data` | Generate JSON data only (no HTML) |

Session data (tokens, cost, user, project, ai_estimated) is logged by the `session-stop.js` hook to `.ai-memory/session-end-events.jsonl` (git-tracked for team reports).
AI story-point estimates are cached in `.ai-memory/ai-estimates.json` (keyed by ticket, written by `scripts/set-ai-estimate.js`, read by the token dashboard).

**Analysis scripts:**
| Script | Purpose |
|--------|---------|
| `./scripts/deep-map <project>` | Deep codebase analysis (structure, deps, hot files, API, tests, patterns) |
| `./scripts/fresh-context` | Save context snapshot for clean session resume |
| `./scripts/wave-planner <EPIC-KEY>` | Group tasks into parallel execution waves |
| `./scripts/learn-from-pr <PR#>` | Extract rules from PR review comments |
| `./scripts/snapshot-compare before\|after <project>` | Before/after performance comparison |

## Upstream Port (Workspace Drift)

This workspace is the **generic distribution** of Lane. Features are built first in a
project-coupled workspace (configured in `.ai-config/upstream.json`), then ported here and
scrubbed of project vocabulary. Use `/port-upstream` for the full procedure.

| Command | Purpose |
|---------|---------|
| `npm run drift` | What this workspace is missing from upstream, classified portable vs project-specific |
| `npm run drift:summary` | Gap counts by area |
| `npm run drift:scan -- <path...>` | Post-port gate — fails if local files still name the upstream project |

Full procedure, config schema, and the port log: [docs/reference/upstream-port.md](docs/reference/upstream-port.md).
Not to be confused with `./scripts/sync`, which syncs *your* lessons/memory across *your* machines.

**Files:**
- **Team rules:** `scripts/self-improvement/rules-shared.json` (git-tracked)
- **Personal rules:** `scripts/self-improvement/rules.json` (gitignored, untracked, local-only — never committed; shared only via `rules:promote-apply` → `rules-shared.json`). See [prompt-hook-learning-system.md](docs/architecture/prompt-hook-learning-system.md#rulesjson-is-personal-and-local-only).
- **Session events:** `.ai-memory/session-end-events.jsonl` (git-tracked, team token data)
- **Config:** `scripts/self-improvement/config.json`

**Infrastructure (optional):** `docker compose up -d` starts Qdrant for semantic search + auto rule extraction. Team rules work without it.

## Node Port Status

**Node port complete** — all bash hooks, operational scripts, bootstrap, the token dashboard, and the AWS infra scripts are ported to Node 20+ in Phases 1–8. WSL no longer required on Windows; see [`docs/wsl-deprecation.md`](docs/wsl-deprecation.md).

**Hook conventions** (all files under `scripts/hooks/`):

- CommonJS modules with `'use strict';` header and `module.exports = ...`.
- Builtins imported with the `node:` prefix (`require('node:fs')`, `require('node:path')`, etc.).
- Cross-terminal contention safety via `atomicWrite()` from [`scripts/_lib/process.js`](scripts/_lib/process.js) — never write hook state with raw `fs.writeFileSync`.
- Tests live in `tests/hooks/` and use `node:test` + `node:assert` (no jest, mocha, or external runners). Tempdir fixtures via `node:os` `tmpdir()` + `node:fs/promises` `mkdtemp`.

**Phase spec references:**

| Phase | Scope | Spec |
|-------|-------|------|
| 1 | `session-stop` hook | [`docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md`](docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md) |
| 2 | Task summaries | [`docs/specs/spec-2026-05-06-task-summaries.md`](docs/specs/spec-2026-05-06-task-summaries.md) |
| 3 | User-facing scripts | [`docs/specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md`](docs/specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md) |
| 4 | `git-merge-jsonl-union` driver + `eol=lf` rules | Commits `341644b`, `5a59f4d`, `6a18ab5` (no standalone spec) |
| 5 | Remaining 6 hooks + CI matrix + WSL notice | [`docs/specs/spec-2026-05-06-node-port-phase-5-complete.md`](docs/specs/spec-2026-05-06-node-port-phase-5-complete.md) |
| 6 | Operational one-shot scripts (`audit-session-attribution`, `backfill-jira-from-commits`, `reconcile-session-attribution`, `backfill-task-from-transcripts`, `setup-merge-drivers`) | [`docs/specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md`](docs/specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md) |
| 7 | `scripts/setup` (interactive bootstrap) + `scripts/token-dashboard.sh` (token consumption HTML dashboard) | [`docs/specs/spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md`](docs/specs/spec-2026-05-06-node-port-phase-7-setup-token-dashboard.md) |
| 8 | `infra/token-dashboard/{setup,deploy,teardown}.{sh→js}` (AWS infra Node port via aws-sdk v3) + orphaned `tests/session-id-attribution.test.sh` cleanup | [`docs/specs/spec-2026-05-06-node-port-phase-8-aws-infra-orphaned-test.md`](docs/specs/spec-2026-05-06-node-port-phase-8-aws-infra-orphaned-test.md) |

The Phase 6 bash filenames remain as 2-line stubs delegating to the `.js` implementations for cross-OS invocability.

## Documentation Standards

Follow [MARKDOWN_GUIDE.md](MARKDOWN_GUIDE.md) for all documentation.

## Key Principles

- **Phase-Based**: Clear structure
- **Specialized**: Each agent is an expert
- **Agnostic**: Works with any tech stack
- **Minimal**: Only essential tools
- **Educational**: Learn as you build
- **Self-Learning**: Hook-driven, zero manual intervention

## Reference Documentation

For detailed documentation, read these files on-demand:

- **Setup & Configuration** → [docs/reference/setup-config.md](docs/reference/setup-config.md)
- **All Scripts & Tools** → [docs/reference/scripts.md](docs/reference/scripts.md)
- **Jira Epic Workflow** → [docs/reference/jira-epic.md](docs/reference/jira-epic.md)
- **Workspace Structure** → [docs/reference/workspace-structure.md](docs/reference/workspace-structure.md)
- **MCP Services** → [docs/reference/mcp-services.md](docs/reference/mcp-services.md)
- **Skill Deployment Playbook** (scheduling a skill: local / Bitbucket / Managed Agents) → [docs/reference/skill-deployment.md](docs/reference/skill-deployment.md)
- **Upstream Port** (closing drift with the project workspace) → [docs/reference/upstream-port.md](docs/reference/upstream-port.md)
- **Lane Memory Protocol** (observation store, MCP tools, team sharing) → [docs/reference/memory-protocol.md](docs/reference/memory-protocol.md)
- **Prompt / Hook / Rules / Learning System (E2E)** → [docs/architecture/prompt-hook-learning-system.md](docs/architecture/prompt-hook-learning-system.md)
- **Agent Definitions** → `agent/_phases/`
- **Agent Team Definitions** → `.claude/agents/` (spec-writer, breakdown-planner, implementer, reliability-hunter)
- **Slash Commands** → `.claude/commands/` (spec, breakdown, swarm-implement, work-ticket, etc.)
- **Core Orchestration** → `agent/_core/`
