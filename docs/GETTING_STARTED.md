# Getting Started with Lane

A practical guide for engineers new to the phase-based AI workflow orchestrator.

---

## Choose Your Environment

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                         PICK YOUR ENVIRONMENT                                  ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────────────────┐       ┌─────────────────────────────┐       ║
║   │                             │       │                             │       ║
║   │      ⌨️  TERMINAL            │       │      🖥️  CURSOR IDE          │       ║
║   │      Claude Code CLI        │       │      Visual Editor          │       ║
║   │                             │       │                             │       ║
║   │  ┌───────────────────────┐  │       │  ┌───────────────────────┐  │       ║
║   │  │ $ claude              │  │       │  │ [Explorer] [Editor]   │  │       ║
║   │  │ > /work-ticket "..."  │  │       │  │ [Claude Panel ▼]      │  │       ║
║   │  │                       │  │       │  │                       │  │       ║
║   │  └───────────────────────┘  │       │  └───────────────────────┘  │       ║
║   │                             │       │                             │       ║
║   │  ✓ Power users              │       │  ✓ Visual learners          │       ║
║   │  ✓ Keyboard-focused         │       │  ✓ See code inline          │       ║
║   │  ✓ Remote/server work       │       │  ✓ File tree navigation     │       ║
║   │  ✓ 5 min setup              │       │  ✓ 10 min setup             │       ║
║   │                             │       │                             │       ║
║   └─────────────────────────────┘       └─────────────────────────────┘       ║
║                                                                               ║
║                    Both use SAME commands, SAME workflow                      ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## Environment 1: Claude Code CLI (Terminal)

### What It Looks Like

```
┌─────────────────────────────────────────────────────────────────┐
│  Terminal                                                       │
├─────────────────────────────────────────────────────────────────┤
│  $ claude                                                       │
│                                                                 │
│   _                                                             │
│  | |    __ _ _ __   ___                                         │
│  | |   / _` | '_ \ / _ \                                        │
│  | |__| (_| | | | |  __/                                        │
│  |____|\__,_|_| |_|\___|                                        │
│    Phase-Based Development                                      │
│                                                                 │
│  Type /work-ticket "your task" to start                         │
│                                                                 │
│  > /work-ticket "Add dark mode toggle"                          │
│                                                                 │
│  ## Task Analysis                                               │
│  **Detected Workflow**: Full BMAD                               │
│  **Phases**: Planning → Implementation → Delivery               │
│                                                                 │
│  ## Now Acting as: Architect                                    │
│  I'll design the theme system architecture...                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Setup Steps

```bash
# 1. Install Claude Code CLI (one-time)
npm install -g @anthropic-ai/claude-code

# 2. Clone the workspace
git clone https://github.com/mazaia/lane.git
cd lane

# 3. Run setup (creates workspace structure)
./scripts/setup

# 4. Add your project (git platform auto-detected!)
./scripts/add-project ~/code/my-app           # Local project
./scripts/add-project https://github.com/...  # GitHub
./scripts/add-project https://bitbucket.org/... # Bitbucket

# 5. Start Claude
claude

# 6. You're ready! Start a workflow:
/work-ticket "Your first task"
```

### Terminal Tips

| Tip | Description |
|-----|-------------|
| **Tab completion** | Press Tab to complete commands |
| **History** | Up/Down arrows to navigate command history |
| **Clear screen** | `Ctrl+L` or type `clear` |
| **Exit** | Type `exit` or `Ctrl+D` |

### Common Terminal Commands

```bash
# Check session status
/progress

# List available projects
./scripts/list-projects

# View session file directly
cat .ai-session/current.yaml
```

---

## Environment 2: Cursor IDE

### What It Looks Like

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Cursor IDE                                                             │
├──────────────────────────────────┬──────────────────────────────────────┤
│  Explorer                        │  Editor                              │
│  ─────────                       │  ──────                              │
│  > agent/                        │  // Your code here                   │
│    > _core/                      │  function ThemeToggle() {            │
│    > _phases/                    │    const { theme, toggle } = ...     │
│    > _projects/                  │                                      │
│  > docs/                         │──────────────────────────────────────│
│  > scripts/                      │  Claude Panel                        │
│                                  │  ────────────                        │
│                                  │  > /work-ticket "Add dark mode"      │
│                                  │                                      │
│                                  │  ## Now Acting as: Developer         │
│                                  │  I'll implement the theme toggle...  │
│                                  │                                      │
└──────────────────────────────────┴──────────────────────────────────────┘
```

### Setup Steps

1. **Install Cursor IDE**: Download from [cursor.sh](https://cursor.sh)

2. **Open Workspace**: File → Open Folder → select `lane`

3. **Verify MCP**: Check status bar shows MCP services connected

4. **Open Claude Panel**:
   - Mac: `Cmd+Shift+P` → "Claude: Open Panel"
   - Windows: `Ctrl+Shift+P` → "Claude: Open Panel"

5. **Start Working**:
   ```
   /work-ticket "Your first task"
   ```

### Cursor Tips

| Tip | Description |
|-----|-------------|
| **Split view** | Keep Claude panel open alongside editor |
| **File tree** | Watch new files appear as agents create them |
| **Inline edits** | Accept AI suggestions directly in code |
| **Multi-cursor** | `Cmd+D` to select next occurrence |

### Cursor Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+P` | Command palette |
| `Cmd/Ctrl+P` | Quick open file |
| `Cmd/Ctrl+B` | Toggle sidebar |

---

## Side-by-Side Comparison

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                       TERMINAL vs CURSOR COMPARISON                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   FEATURE              ⌨️ TERMINAL                   🖥️ CURSOR                │
│   ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│   Starting work        $ claude                     Open Curosr Chat        │
│                        > /work-ticket "task"        > /work-ticket "task"    │
│                                                                              │
│   See files            ls, cat, tree                Visual file tree         │
│                                                                              │
│   Edit code            Opens in $EDITOR             Inline in editor         │
│                                                                              │
│   Check progress       /progress                    /progress                │
│                                                                              │
│   View session         cat .ai-session/...          Click file in Explorer   │
│                                                                              │
│   ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│   BEST FOR:                                                                  │
│                                                                              │
│   ⌨️ Terminal           🖥️ Cursor                                             │
│   ───────────          ─────────                                             │
│   ✓ Keyboard lovers    ✓ Visual learners                                     │
│   ✓ SSH/remote work    ✓ Code + AI side by side                              │
│   ✓ Minimal UI         ✓ New to workspace                                    │
│   ✓ Scripting          ✓ Integrated editing                                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Your First Workflow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           YOUR FIRST 5 MINUTES                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 1: List Projects                                                      │
│   ═════════════════════                                                      │
│                                                                              │
│       $ ./scripts/list-projects                                              │
│                                                                              │
│       📁 my-app                                                              │
│       📁 another-project                                                     │
│       📁 ...                                                                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 2: Start a Task                                                       │
│   ════════════════════                                                       │
│                                                                              │
│       > /work-ticket "Fix the typo in README"                                │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 3: Watch It Work                                                      │
│   ═════════════════════                                                      │
│                                                                              │
│       ┌─────────────────────────────────────────────────────────┐            │
│       │                                                         │            │
│       │   /work-ticket "task"                                   │            │
│       │         │                                               │            │
│       │         ▼                                               │            │
│       │   ┌──────────┐    "Quick Flow detected"                 │            │
│       │   │ ANALYZE  │                                          │            │
│       │   └────┬─────┘                                          │            │
│       │        │                                                │            │
│       │        ▼                                                │            │
│       │   ┌──────────┐                                          │            │
│       │   │    💻    │    Developer fixes the code              │            │
│       │   │DEVELOPER │                                          │            │
│       │   └────┬─────┘                                          │            │
│       │        │                                                │            │
│       │        ▼                                                │            │
│       │   ┌──────────┐                                          │            │
│       │   │    🧪    │    Tester validates                      │            │
│       │   │  TESTER  │                                          │            │
│       │   └────┬─────┘                                          │            │
│       │        │                                                │            │
│       │        ▼                                                │            │
│       │   ┌──────────┐                                          │            │
│       │   │    🚀    │    Deployer opens PR                     │            │
│       │   │ DEPLOYER │                                          │            │
│       │   └────┬─────┘                                          │            │
│       │        │                                                │            │
│       │        ▼                                                │            │
│       │   ┌──────────┐                                          │            │
│       │   │    👤    │    YOU review and merge                  │            │
│       │   │   YOU    │                                          │            │
│       │   └──────────┘                                          │            │
│       │                                                         │            │
│       └─────────────────────────────────────────────────────────┘            │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 4: Check Progress (anytime)                                           │
│   ════════════════════════════════                                           │
│                                                                              │
│       > /progress                                                            │
│                                                                              │
│       Current: 🧪 Tester (Phase 3)                                           │
│       Completed: Architect, Designer, Developer                              │
│       Next: Reviewer                                                         │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              COMMON ISSUES                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PROBLEM: "claude: command not found"                                       │
│   ════════════════════════════════════                                       │
│                                                                              │
│       $ npm install -g @anthropic-ai/claude-code                             │
│       $ claude --version                                                     │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PROBLEM: Claude Panel not showing in Cursor                                │
│   ═══════════════════════════════════════════                                │
│                                                                              │
│       1. Check: Does .mcp.json exist in workspace root?                      │
│       2. Try:   Cmd+Shift+P → "Developer: Reload Window"                     │
│       3. Check: Is Claude extension enabled?                                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PROBLEM: "No active session"                                               │
│   ════════════════════════════                                               │
│                                                                              │
│       > /work-ticket "your task description"                                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PROBLEM: Session state corrupted                                           │
│   ══════════════════════════════                                             │
│                                                                              │
│       $ rm -rf .ai-session/                                                  │
│       > /work-ticket "your task"                                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## What's Next?

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              LEARNING PATH                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│        ┌─────────────┐                                                       │
│        │   YOU ARE   │                                                       │
│        │    HERE     │                                                       │
│        └──────┬──────┘                                                       │
│               │                                                              │
│               ▼                                                              │
│        ┌─────────────┐     Learn all /commands                               │
│     1. │   SLASH     │───► docs/SLASH_COMMANDS.md                            │
│        │  COMMANDS   │                                                       │
│        └──────┬──────┘                                                       │
│               │                                                              │
│               ▼                                                              │
│        ┌─────────────┐     Understand quality gates                          │
│     2. │ VALIDATION  │───► docs/VALIDATION_PROCESS.md                        │
│        │   PROCESS   │                                                       │
│        └──────┬──────┘                                                       │
│               │                                                              │
│               ▼                                                              │
│        ┌─────────────┐     Meet the 9 agents                                 │
│     3. │   AGENT     │───► AGENT_GUIDE.md                                    │
│        │    GUIDE    │                                                       │
│        └──────┬──────┘                                                       │
│               │                                                              │
│               ▼                                                              │
│        ┌─────────────┐                                                       │
│     4. │   TRY IT!   │───► /work-ticket "Add a simple feature"               │
│        │             │                                                       │
│        └─────────────┘                                                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Additional Setup (one-time)

After cloning the workspace and running `./scripts/setup`, install the extra dependencies for TypeScript tooling and the self-improvement system:

```bash
npm install                     # TypeScript + self-improvement deps
docker compose up -d            # Qdrant (optional, for semantic search)
```

**Team rules work without Qdrant** — they're injected via a lightweight JSON+keyword hook. Qdrant is only needed if you want semantic vector search for memory and context retrieval.

---

**Questions?** Check the troubleshooting section or ask in your team's channel.
