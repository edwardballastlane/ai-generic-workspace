# Self-Learning Protocol

This protocol is embedded in all AI tool instruction files. It tells the AI to automatically load, capture, and save lessons without user intervention.

## On Session Start (Automatic)

**BEFORE any work, the AI MUST run:**

```bash
./scripts/load-lessons <project-name>
```

Read the output and apply all rules to your work. These are lessons learned from past sessions — treat them as project-specific coding standards.

If the project has no lessons yet, proceed normally. Lessons will accumulate over time.

## During Work (Continuous Evaluation)

At every **handoff between agents** (or at natural checkpoints if not using the phase system), the AI MUST evaluate:

1. **Was I corrected by the user?** → The correct approach is a lesson
2. **Did a build/test fail because of a project convention I didn't know?** → That convention is a lesson
3. **Did I discover a reusable pattern specific to this project?** → That pattern is a lesson
4. **Did I find that a certain approach doesn't work here?** → That anti-pattern is a lesson
5. **Did the user express a preference?** → That preference is a lesson

If ANY of the above is true, capture it immediately:

```bash
./scripts/capture-lesson --project <project> --category <category> \
  --agent <current-agent> --severity <level> "The lesson learned"
```

**Categories:** `code-quality`, `security`, `testing`, `architecture`, `git`, `performance`
**Severity:** `critical` (breaks things), `high` (causes rework), `medium` (good to know), `low` (nice to have)

## On Session End (Automatic)

When the workflow is complete, the AI MUST:

```bash
./scripts/save-session-memory "Brief summary of what was accomplished"
```

This preserves the session for future reference. Past sessions are automatically loaded when starting new work on the same project.

## Lesson Capture Examples

```bash
# User corrected: "we use pnpm here, not npm"
./scripts/capture-lesson --project my-app --category architecture \
  --agent developer --severity high "Use pnpm as package manager, never npm"

# Build failed: unknown import alias
./scripts/capture-lesson --project my-app --category code-quality \
  --agent developer --severity high "Import paths use @/ alias mapped to src/"

# Discovered pattern: all API calls go through a wrapper
./scripts/capture-lesson --project my-app --category code-quality \
  --agent developer --severity medium "All API calls must use src/lib/api-client.ts wrapper"

# PR was rejected: missing test
./scripts/capture-lesson --project my-app --category testing \
  --agent developer --severity high --source pr-review \
  "All new endpoints require integration tests in tests/integration/"

# User preference
./scripts/capture-lesson --global --category git \
  --agent deployer --severity medium "Always use conventional commits format"
```
