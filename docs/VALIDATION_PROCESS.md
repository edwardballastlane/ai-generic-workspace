# Output Validation Process

What happens behind the scenes and what you need to do as an engineer.

---

## Your Role at a Glance

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                            YOUR WORKFLOW                                       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────┐                                              ┌─────────────┐    ║
║   │   YOU   │                                              │   YOU       │    ║
║   │  START  │─────────────────────────────────────────────>│   REVIEW    │    ║
║   └────┬────┘                                              └──────┬──────┘    ║
║        │                                                          │           ║
║        │  /work-ticket "task"                                     │  Approve  ║
║        │                                                          │  & Merge  ║
║        ▼                                                          ▼           ║
║   ╔════════════════════════════════════════════════════════════════════╗      ║
║   ║                    AI HANDLES EVERYTHING                           ║      ║
║   ║                                                                    ║      ║
║   ║   🏗️ Architect ──► 🎨 Designer ──► 💻 Developer ──► 🧪 Tester      ║      ║
║   ║                                         │              │           ║      ║
║   ║                                         ▼              ▼           ║      ║
║   ║                                    ┌─────────┐    ┌─────────┐      ║      ║
║   ║                                    │  BUILD  │    │  TESTS  │      ║      ║
║   ║                                    │  ✓ PASS │    │  ✓ PASS │      ║      ║
║   ║                                    └─────────┘    └─────────┘      ║      ║
║   ║                                                        │           ║      ║
║   ║                              👀 Reviewer ◄─────────────┘           ║      ║
║   ║                                    │                               ║      ║
║   ║                                    ▼                               ║      ║
║   ║                              🚀 Deployer ──► Opens PR              ║      ║
║   ║                                                                    ║      ║
║   ╚════════════════════════════════════════════════════════════════════╝      ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

**You only do 2 things**: Start the workflow, then review the PR.

---

## The Complete Journey

```
    ┌──────────────────────────────────────────────────────────────────────────┐
    │                                                                          │
    │   /work-ticket "Add dark mode"                                           │
    │                                                                          │
    └────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
    ┌──────────────────────────────────────────────────────────────────────────┐
    │  PHASE 1: ROUTING                                                        │
    │  ════════════════                                                        │
    │                                                                          │
    │    "Add dark mode"  ───►  Analyzed  ───►  Full BMAD workflow selected    │
    │                                                                          │
    └────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
    ┌──────────────────────────────────────────────────────────────────────────┐
    │  PHASE 2: PLANNING                                                       │
    │  ═════════════════                                                       │
    │                                                                          │
    │    ┌───────────┐         ┌───────────┐         ┌───────────┐             │
    │    │    🏗️     │         │    🎨     │         │    📝     │             │
    │    │ ARCHITECT │────────►│ DESIGNER  │────────►│TECH WRITER│             │
    │    │           │         │           │         │           │             │
    │    │  Designs  │         │  Creates  │         │  Plans    │             │
    │    │  system   │         │  UI specs │         │  docs     │             │
    │    └───────────┘         └───────────┘         └───────────┘             │
    │                                                                          │
    └────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
    ┌──────────────────────────────────────────────────────────────────────────┐
    │  PHASE 3: IMPLEMENTATION                                                 │
    │  ════════════════════════                                                │
    │                                                                          │
    │    ┌───────────┐                                                         │
    │    │    💻     │                                                         │
    │    │ DEVELOPER │                                                         │
    │    │           │                                                         │
    │    │  Writes   │                                                         │
    │    │  code     │                                                         │
    │    └─────┬─────┘                                                         │
    │          │                                                               │
    │          ▼                                                               │
    │    ┌─────────────────────────────────────────┐                           │
    │    │           BUILD CHECKPOINT              │                           │
    │    │    ┌─────────────────────────────┐      │                           │
    │    │    │    npm run build            │      │                           │
    │    │    │    ════════════════         │      │                           │
    │    │    │    ✓ Compiles               │      │                           │
    │    │    │    ✓ No type errors         │      │                           │
    │    │    │    ✓ No import errors       │      │                           │
    │    │    └─────────────────────────────┘      │                           │
    │    └─────────────────┬───────────────────────┘                           │
    │                      │                                                   │
    │                      ▼                                                   │
    │    ┌───────────┐         ┌───────────┐                                   │
    │    │    🧪     │         │    👀     │                                   │
    │    │  TESTER   │────────►│ REVIEWER  │                                   │
    │    │           │         │           │                                   │
    │    │  Runs     │         │  Checks   │                                   │
    │    │  tests    │         │  quality  │                                   │
    │    └───────────┘         └───────────┘                                   │
    │                                                                          │
    └────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
    ┌──────────────────────────────────────────────────────────────────────────┐
    │  PHASE 4: DELIVERY                                                       │
    │  ═════════════════                                                       │
    │                                                                          │
    │    ┌───────────┐                                                         │
    │    │    🚀     │                                                         │
    │    │ DEPLOYER  │                                                         │
    │    │           │                                                         │
    │    │ 1. Asks   │◄─── "What branch name?"                                 │
    │    │    you    │◄─── "What base branch?"                                 │
    │    │           │                                                         │
    │    │ 2. Checks │───► gh pr list --merged (learns PR format)              │
    │    │    format │                                                         │
    │    │           │                                                         │
    │    │ 3. Opens  │───► PR with evidence                                    │
    │    │    PR     │                                                         │
    │    └───────────┘                                                         │
    │                                                                          │
    └────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
    ┌──────────────────────────────────────────────────────────────────────────┐
    │  PHASE 5: YOUR REVIEW                                                    │
    │  ════════════════════                                                    │
    │                                                                          │
    │         ┌─────────────────────────────────────────────────┐              │
    │         │                  PR READY                       │              │
    │         │  ═══════════════════════════════════════════    │              │
    │         │                                                 │              │
    │         │  ## Summary                                     │              │
    │         │  - Added ThemeContext                           │              │
    │         │  - Created ThemeToggle component                │              │
    │         │                                                 │              │
    │         │  ## Evidence                                    │              │
    │         │  ┌────────────┬────────────┬────────────┐       │              │
    │         │  │   BUILD    │   TESTS    │  COVERAGE  │       │              │
    │         │  │   ✓ PASS   │  18/18 ✓   │    85%     │       │              │
    │         │  └────────────┴────────────┴────────────┘       │              │
    │         │                                                 │              │
    │         └─────────────────────────────────────────────────┘              │
    │                              │                                           │
    │                              ▼                                           │
    │              ┌───────────────────────────────┐                           │
    │              │        YOUR DECISION          │                           │
    │              └───────────────┬───────────────┘                           │
    │                              │                                           │
    │              ┌───────────────┴───────────────┐                           │
    │              │                               │                           │
    │              ▼                               ▼                           │
    │    ┌─────────────────┐             ┌─────────────────┐                   │
    │    │    ✓ APPROVE    │             │  ✗ REQUEST      │                   │
    │    │    & MERGE      │             │    CHANGES      │                   │
    │    └─────────────────┘             └────────┬────────┘                   │
    │                                             │                            │
    │                                             ▼                            │
    │                                    ┌─────────────────┐                   │
    │                                    │  AI fixes and   │                   │
    │                                    │  updates PR     │──────► Back to    │
    │                                    └─────────────────┘        your review│
    │                                                                          │
    └──────────────────────────────────────────────────────────────────────────┘
```

---

## Engineer Checklist

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   STEP 1: START                                                              │
│   ══════════════                                                             │
│                                                                              │
│   □  Run:  /work-ticket "your task description"                              │
│   □  Be specific: "Add user avatar upload with 2MB limit"                    │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 2: ANSWER QUESTIONS (when asked)                                      │
│   ══════════════════════════════════════                                     │
│                                                                              │
│   □  Branch name?     → "feature/user-avatar"                                │
│   □  Base branch?     → "dev" or "main"                                      │
│   □  Approve PR?      → "Yes" or request changes                             │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 3: REVIEW PR                                                          │
│   ═════════════════                                                          │
│                                                                              │
│   □  Check build passed                                                      │
│   □  Check tests passed                                                      │
│   □  Review code changes                                                     │
│   □  Verify it does what you asked                                           │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STEP 4: APPROVE & MERGE                                                    │
│   ════════════════════════                                                   │
│                                                                              │
│   □  Approve PR                                                              │
│   □  Merge to target branch                                                  │
│   □  Done!                                                                   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Quality Gates Visualized

```
                              QUALITY GATES
    ════════════════════════════════════════════════════════════════

    Code Written
         │
         ▼
    ┌─────────────┐
    │   GATE 1    │     npm run build
    │   BUILD     │─────────────────────────────────────────┐
    │             │                                         │
    └──────┬──────┘                                         │
           │                                                │
           │ ✓ PASS                                   ✗ FAIL│
           │                                                │
           ▼                                                ▼
    ┌─────────────┐                                 ┌───────────────┐
    │   GATE 2    │     npm test                    │   Developer   │
    │   TESTS     │────────────────────┐            │   fixes and   │
    │             │                    │            │   rebuilds    │
    └──────┬──────┘                    │            └───────────────┘
           │                           │
           │ ✓ PASS              ✗ FAIL│
           │                           │
           ▼                           ▼
    ┌─────────────┐            ┌───────────────┐
    │   GATE 3    │            │   Developer   │
    │   REVIEW    │            │   fixes and   │
    │             │            │   re-tests    │
    └──────┬──────┘            └───────────────┘
           │
           │ ✓ APPROVED
           │
           ▼
    ┌─────────────┐
    │   GATE 4    │
    │   HUMAN     │◄──── YOU ARE HERE
    │   REVIEW    │
    └──────┬──────┘
           │
           │ ✓ APPROVED
           │
           ▼
    ┌─────────────┐
    │   MERGED    │
    │   TO MAIN   │
    └─────────────┘
```

---

## Workflow Types Comparison

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   QUICK FLOW (Bug Fixes)                                          ~5 min    │
│   ══════════════════════                                                     │
│                                                                              │
│   💻 ────► 🧪 ────► 🚀 ────► 👤                                              │
│   Dev     Test    Deploy   You                                               │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   FULL BMAD (Features)                                           ~15 min    │
│   ════════════════════                                                       │
│                                                                              │
│   🏗️ ────► 🎨 ────► 💻 ────► 🧪 ────► 👀 ────► 🚀 ────► 📚 ────► 👤         │
│   Arch    Design  Dev     Test    Review  Deploy  Docs    You               │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ENTERPRISE (Systems)                                           ~30 min    │
│   ════════════════════                                                       │
│                                                                              │
│   🔍 ────► 📊 ────► 🏗️ ────► 🎨 ────► 💻 ────► 🧪 ────► 👀 ────► 🚀 ────► 👤│
│   Analyst  PO     Arch    Design  Dev     Test    Review  Deploy  You       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## What to Check in PR Review

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           PR REVIEW CHECKLIST                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │  EVIDENCE SECTION                                                  │     │
│   │  ════════════════                                                  │     │
│   │                                                                    │     │
│   │    ┌──────────┐    ┌──────────┐    ┌──────────┐                    │     │
│   │    │  BUILD   │    │  TESTS   │    │ COVERAGE │                    │     │
│   │    │          │    │          │    │          │                    │     │
│   │    │  ✓ PASS  │    │  24/24   │    │   87%    │                    │     │
│   │    │          │    │    ✓     │    │          │                    │     │
│   │    └──────────┘    └──────────┘    └──────────┘                    │     │
│   │                                                                    │     │
│   │    ▲                ▲                ▲                             │     │
│   │    │                │                │                             │     │
│   │    Must be PASS     All green        Acceptable?                   │     │
│   │                                      (team decides)                │     │
│   └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │  CODE CHANGES                                                      │     │
│   │  ════════════                                                      │     │
│   │                                                                    │     │
│   │    □  Does it do what was requested?                               │     │
│   │    □  Clean code, proper patterns?                                 │     │
│   │    □  No obvious security issues?                                  │     │
│   │    □  Tests are meaningful?                                        │     │
│   │                                                                    │     │
│   └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## When Things Go Wrong

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   SCENARIO: BUILD FAILS                                                      │
│   ═════════════════════                                                      │
│                                                                              │
│       💻 Developer                                                           │
│           │                                                                  │
│           ▼                                                                  │
│       ┌───────┐                                                              │
│       │ BUILD │──── ✗ FAIL ────►  AI automatically:                         │
│       └───────┘                    1. Shows error                            │
│           │                        2. Developer fixes                        │
│           │                        3. Rebuilds                               │
│       ✓ PASS                                                                 │
│           │                                                                  │
│           ▼                                                                  │
│       Continue...                                                            │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SCENARIO: YOU REQUEST CHANGES                                              │
│   ═════════════════════════════                                              │
│                                                                              │
│       👤 You: "Add input validation"                                         │
│           │                                                                  │
│           ▼                                                                  │
│       ┌─────────────────────────────────────────────┐                        │
│       │                                             │                        │
│       │   💻 Developer fixes                        │                        │
│       │       │                                     │                        │
│       │       ▼                                     │                        │
│       │   🧪 Tester re-validates                    │                        │
│       │       │                                     │                        │
│       │       ▼                                     │                        │
│       │   👀 Reviewer re-approves                   │                        │
│       │       │                                     │                        │
│       │       ▼                                     │                        │
│       │   📝 New commit pushed                      │                        │
│       │                                             │                        │
│       └─────────────────────────────────────────────┘                        │
│           │                                                                  │
│           ▼                                                                  │
│       👤 You review again                                                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Overview

The validation process ensures quality through multiple checkpoints:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        VALIDATION CYCLE                                 │
│                                                                         │
│   AI Work          Feedback Loop         Evidence          Human Review │
│  ┌───────┐        ┌───────────────┐     ┌────────┐        ┌──────────┐ │
│  │ Agent │───────>│ Tester        │────>│ PR/    │───────>│ Engineer │ │
│  │ Work  │        │ Reviewer      │     │ Commit │        │ Approval │ │
│  └───────┘        └───────────────┘     └────────┘        └──────────┘ │
│      │                   │                   │                   │     │
│      └───────────────────┴───────────────────┴───────────────────┘     │
│                              Iterate until approved                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The Feedback Loop

### 1. Agent-to-Agent Quality Gates

Each handoff acts as a quality checkpoint:

| From | To | Quality Check |
|------|-----|---------------|
| Architect | Designer | Architecture is implementable |
| Designer | Developer | Designs are complete with specs |
| Developer | Tester | Code is testable, builds successfully |
| Tester | Reviewer | Tests pass, coverage adequate |
| Reviewer | Deployer | Code meets standards, approved |

**Handoff Summary Format:**

```markdown
## Handoff: Developer → Tester

### Completed Work
- Implemented ThemeContext with CSS custom properties
- Created ThemeToggle component
- Added localStorage persistence

### Quality Checklist
- [x] Code compiles without errors
- [x] Unit tests written
- [x] Follows existing patterns

### Context for Tester
Focus on theme switching edge cases:
- System preference detection
- localStorage fallback
- Hydration timing
```

### 2. Tester Agent Validation

The Tester agent performs systematic validation:

```
┌─────────────────────────────────────────────┐
│              TESTER VALIDATION              │
├─────────────────────────────────────────────┤
│ 1. Build Verification                       │
│    └─ npm run build (must pass)             │
├─────────────────────────────────────────────┤
│ 2. Test Execution                           │
│    ├─ Unit tests: npm test                  │
│    ├─ Integration tests                     │
│    └─ E2E tests (if applicable)             │
├─────────────────────────────────────────────┤
│ 3. Coverage Analysis                        │
│    └─ Minimum threshold check               │
├─────────────────────────────────────────────┤
│ 4. Edge Case Testing                        │
│    └─ Based on acceptance criteria          │
├─────────────────────────────────────────────┤
│ 5. Report Generation                        │
│    └─ test-results.md                       │
└─────────────────────────────────────────────┘
```

**Test Report Output:**

```markdown
## Test Results

**Status**: PASSED
**Coverage**: 87%
**Tests Run**: 24

### Results by Category
| Category | Passed | Failed | Skipped |
|----------|--------|--------|---------|
| Unit | 18 | 0 | 0 |
| Integration | 4 | 0 | 1 |
| E2E | 1 | 0 | 0 |

### Edge Cases Verified
- [x] Theme persists across page refresh
- [x] System preference fallback works
- [x] No flash of wrong theme on load
```

### 3. Reviewer Agent Checks

The Reviewer agent validates code quality:

| Check | Criteria |
|-------|----------|
| **Code Style** | Follows project conventions |
| **Patterns** | Uses established patterns |
| **Security** | No obvious vulnerabilities |
| **Performance** | No obvious bottlenecks |
| **Documentation** | Code is self-documenting or commented |
| **Tests** | Adequate coverage for changes |

**Review Output:**

```markdown
## Code Review

**Decision**: APPROVED with minor suggestions

### Checks
- [x] Code style consistent
- [x] Patterns followed
- [x] No security issues
- [x] Performance acceptable
- [x] Tests adequate

### Suggestions (non-blocking)
1. Consider memoizing theme value in context
2. Add JSDoc to ThemeContext exports
```

---

## Evidence Generation

### PR/Pull Request Creation

The Deployer agent creates PRs with standardized format:

**1. Discover Project's PR Format First:**

```bash
# Always run this before creating a PR
gh pr list --state merged --limit 3 --json title,body
```

**2. Create PR Following Project Conventions:**

```markdown
## Summary
- Added dark mode toggle with system preference detection
- Implemented theme persistence via localStorage
- Created ThemeContext for app-wide theme state

## Test Plan
- [x] Unit tests for ThemeContext
- [x] Integration tests for ThemeToggle
- [x] Manual testing on Chrome, Firefox, Safari

## Evidence
- Build: PASSED
- Tests: 24/24 PASSED
- Coverage: 87%

Generated with [Claude Code](https://claude.com/claude-code)
```

### Branch Naming Standards

| Workflow | Branch Format | Example |
|----------|---------------|---------|
| Quick Flow | `fix/description` | `fix/login-redirect` |
| Full BMAD | `feature/description` | `feature/dark-mode` |
| Enterprise | `epic/description` | `epic/auth-system` |

**Important**: Always ask for branch name before creating:
```
Before creating the branch, what would you like to name it?
Also, which branch should I use as the base (e.g., main, dev)?
```

### Commit Message Format

```
<type>: <short description>

<detailed description>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**Types:**
| Type | Use For |
|------|---------|
| `feat` | New features |
| `fix` | Bug fixes |
| `docs` | Documentation |
| `refactor` | Code refactoring |
| `test` | Test additions/changes |
| `chore` | Maintenance tasks |

---

## Human Review Stage

### When to Review

Human review is required at these checkpoints:

```
┌───────────────────────────────────────────────────────────────┐
│                    HUMAN REVIEW POINTS                        │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  1. PR Created                                                │
│     └─ Review code changes                                    │
│                                                               │
│  2. Before Merge                                              │
│     └─ Approve or request changes                             │
│                                                               │
│  3. Post-Deploy (optional)                                    │
│     └─ Verify in staging/production                           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### What to Validate

| Category | What to Check |
|----------|---------------|
| **Correctness** | Does the code do what was requested? |
| **Completeness** | Are all requirements addressed? |
| **Quality** | Is the code maintainable? |
| **Security** | Any security concerns? |
| **Tests** | Are tests meaningful and sufficient? |
| **Docs** | Is documentation updated? |

### Review Checklist

```markdown
## Human Review Checklist

### Functional
- [ ] Feature works as described
- [ ] Edge cases handled
- [ ] Error states handled

### Code Quality
- [ ] Follows project conventions
- [ ] No unnecessary complexity
- [ ] Appropriate abstractions

### Testing
- [ ] Tests are meaningful
- [ ] Coverage is adequate
- [ ] CI/CD passes

### Documentation
- [ ] README updated (if needed)
- [ ] API docs updated (if needed)
- [ ] Comments where necessary
```

### Approval Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│                      APPROVAL WORKFLOW                              │
│                                                                     │
│  PR Created ──> Review ──> Approve ──> Merge ──> Deploy             │
│       │           │           │                     │               │
│       │           │           │                     v               │
│       │           │           │              [Production]           │
│       │           │           │                                     │
│       │           v           │                                     │
│       │    Request Changes    │                                     │
│       │           │           │                                     │
│       │           v           │                                     │
│       └──── AI Fixes ─────────┘                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**If changes requested:**
1. AI receives feedback
2. Developer agent makes corrections
3. Tester re-validates
4. Reviewer re-approves
5. New commit pushed to PR
6. Human re-reviews

---

## Complete Validation Flow

```
 START
   │
   v
┌──────────────────────────────────────────────────────────────────────┐
│  PHASE 3: IMPLEMENTATION                                             │
│                                                                      │
│  Developer ───────────────────────────────────────────────────────>  │
│      │ writes code                                                   │
│      │                                                               │
│      v                                                               │
│  Build Check ─────────────────────────────────────────────────────>  │
│      │ npm run build                                                 │
│      │                                                               │
│      v                                                               │
│  Tester ──────────────────────────────────────────────────────────>  │
│      │ runs tests, validates                                         │
│      │ generates test-results.md                                     │
│      │                                                               │
│      v                                                               │
│  Reviewer ────────────────────────────────────────────────────────>  │
│      │ code review                                                   │
│      │ generates review-comments.md                                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
   │
   v
┌──────────────────────────────────────────────────────────────────────┐
│  PHASE 4: DELIVERY                                                   │
│                                                                      │
│  Deployer ────────────────────────────────────────────────────────>  │
│      │ creates branch                                                │
│      │ commits code                                                  │
│      │ opens PR with evidence                                        │
│      │                                                               │
│      v                                                               │
│  HUMAN REVIEW ────────────────────────────────────────────────────>  │
│      │ engineer reviews PR                                           │
│      │ approves or requests changes                                  │
│      │                                                               │
│      v                                                               │
│  Merge & Deploy ──────────────────────────────────────────────────>  │
│      │ PR merged                                                     │
│      │ CI/CD deploys                                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
   │
   v
  END
```

---

## Quality Metrics

Track these metrics across workflows:

| Metric | Target | Measurement |
|--------|--------|-------------|
| Build Success Rate | 100% | Builds passing first time |
| Test Pass Rate | >95% | Tests passing before PR |
| Review Iterations | <2 | Approvals needed per PR |
| Time to Merge | <1 day | PR open to merged |

---

## Next Steps

- [Usage Guide](USAGE_GUIDE.md) - How to use the orchestrator
- [Slash Commands](SLASH_COMMANDS.md) - Commands for optimization
- [Handoff Protocol](../agent/_core/handoff-protocol.md) - Detailed handoff procedures

---

**Remember**: The AI handles validation loops automatically. Your job is the final human review before merge.
