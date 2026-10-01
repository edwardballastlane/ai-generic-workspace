# BMAD-Inspired Methodology

**Version**: 1.0.0
**Based On**: [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD)

---

## What is BMAD?

**BMAD** (Build More, Architect Dreams) is a structured methodology for AI-assisted software development that uses specialized agents working through defined phases.

Lane adapts BMAD's core principles for general-purpose development with minimal complexity.

---

## Core Principles

### 1. **Scale-Adaptive Intelligence**

The system automatically adjusts planning depth based on project complexity:

```
Small Task (Bug Fix)     → Quick Flow (5 min)
Medium Task (Feature)    → Full BMAD (15 min)
Large Task (System)      → Enterprise (30 min)
```

### 2. **Specialized Expertise**

Instead of one generic AI assistant, you work with **9 specialized agents**:
- Each agent is an expert in their domain
- Clear handoffs between phases
- No confusion about "which AI do I ask?"

### 3. **Structured Collaboration**

Phases provide clear structure:
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  ANALYSIS   │ ──> │  PLANNING   │ ──> │ IMPLEMENT   │ ──> │  DELIVERY   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

### 4. **Document Efficiency**

Inspired by BMAD's "document sharding":
- Break large specs into focused sections
- Load only relevant context per phase
- 90% reduction in token usage
- Faster AI responses

---

## The 4 Phases Explained

### Phase 1: Analysis (Optional)

**Purpose**: Understand the problem space

**When to Use**:
- ✅ Building something new and unclear
- ✅ Need to research requirements
- ✅ Exploring multiple solutions
- ❌ Bug fixes (skip this phase)
- ❌ Well-defined features (start at Planning)

**Agents**:
- **Analyst**: Research and discovery
- **Product Owner**: Requirements and user stories

**Outputs**:
- Requirements documents
- User stories
- Research findings
- Problem definition

**Example**:
```bash
/analyze "Build a real-time chat application"

# Analyst researches WebSocket options
# Product Owner defines user stories
# Output: Requirements doc with tech options
```

---

### Phase 2: Planning

**Purpose**: Design the solution

**When to Use**:
- ✅ All new features
- ✅ Architecture changes
- ✅ Design-heavy work
- ❌ Tiny bug fixes

**Agents**:
- **Architect**: System design and tech decisions
- **Designer**: UX/UI design (Figma integration)
- **Tech Writer**: Documentation planning

**Outputs**:
- Technical specifications
- Architecture diagrams
- Design files (Figma)
- Documentation plan

**Example**:
```bash
/plan "User dashboard with analytics"

# Architect: Designs data flow and API structure
# Designer: Creates Figma mockups
# Tech Writer: Plans documentation structure
```

**MCP Usage**:
- Context7: Research framework patterns
- Figma: Create and review designs

---

### Phase 3: Implementation

**Purpose**: Build and test the solution

**When to Use**:
- ✅ All development work
- ✅ After Planning (or directly for bugs)
- ✅ Includes testing

**Agents**:
- **Developer**: Code implementation
- **Tester**: Test creation and execution
- **Reviewer**: Code review and quality

**Outputs**:
- Working code
- Test suites
- Code review feedback
- Bug fixes

**Example**:
```bash
/implement "Dashboard with charts and filters"

# Developer: Implements React components
# Tester: Creates unit and integration tests
# Reviewer: Reviews code quality
```

**MCP Usage**:
- Context7: API documentation, code examples
- Figma: Extract design specifications

---

### Phase 4: Delivery

**Purpose**: Ship to production

**When to Use**:
- ✅ After implementation
- ✅ Ready to deploy
- ✅ Need final documentation

**Agents**:
- **Deployer**: CI/CD and deployment
- **Documenter**: Final documentation

**Outputs**:
- Deployment configs
- CI/CD pipelines
- User documentation
- Release notes
- API documentation

**Example**:
```bash
/deliver "Deploy dashboard to production"

# Deployer: Sets up Docker and CI/CD
# Documenter: Creates user guide and changelog
```

**MCP Usage**:
- Context7: Platform-specific deployment guides

---

## The 3 Workflow Speeds

### Quick Flow (5 minutes)

**For**: Bug fixes, small changes, hotfixes

**Phases**: Implementation → Delivery

**Process**:
1. Identify issue
2. Fix code
3. Test fix
4. Deploy

**Example**:
```bash
/work-ticket "Fix broken login redirect"

# Skips Analysis and Planning
# Goes straight to Developer agent
# Quick test and deploy
```

---

### Full BMAD (15 minutes)

**For**: New features, components, refactoring

**Phases**: Planning → Implementation → Delivery

**Process**:
1. Design architecture and UI
2. Implement code
3. Write tests
4. Review code
5. Deploy and document

**Example**:
```bash
/work-ticket "Add user profile editing"

# Planning: Architect designs API, Designer creates UI
# Implementation: Developer builds, Tester validates
# Delivery: Deployer ships, Documenter writes guide
```

---

### Enterprise Flow (30 minutes)

**For**: Large systems, architecture changes, new projects

**Phases**: Analysis → Planning → Implementation → Delivery

**Process**:
1. Deep research and requirements
2. Comprehensive planning
3. Iterative implementation
4. Production-grade delivery

**Example**:
```bash
/work-ticket "Build microservices architecture"

# Analysis: Analyst researches patterns, Product Owner defines scope
# Planning: Architect designs system, Tech Writer plans docs
# Implementation: Developer builds services, Tester creates test suite
# Delivery: Deployer sets up orchestration, Documenter writes guides
```

---

## Smart Workflow Router

The `/work-ticket` command analyzes your task and chooses the right workflow:

### Decision Logic

```javascript
function chooseWorkflow(taskDescription) {
  // Keywords for Quick Flow
  if (matches(taskDescription, ['fix', 'bug', 'hotfix', 'patch'])) {
    return 'QUICK_FLOW'
  }

  // Keywords for Enterprise Flow
  if (matches(taskDescription, ['architecture', 'system', 'microservices', 'platform'])) {
    return 'ENTERPRISE_FLOW'
  }

  // Default to Full BMAD
  return 'FULL_BMAD'
}
```

### Examples

| Task | Detected Workflow | Reasoning |
|------|-------------------|-----------|
| "Fix login bug" | Quick Flow | Contains "fix" and "bug" |
| "Add user dashboard" | Full BMAD | New feature, needs design |
| "Build payment system" | Enterprise | Complex system |
| "Update button color" | Quick Flow | Small change |
| "Redesign homepage" | Full BMAD | Design-heavy work |

---

## Phase Transitions

### How to Move Between Phases

#### Manual Transitions
```bash
/analyze      # Start Analysis
/plan         # Move to Planning
/implement    # Move to Implementation
/deliver      # Move to Delivery
```

#### Automatic Transitions
When using `/work-ticket`, phases are activated automatically based on workflow.

### Check Current Phase
```bash
/status       # Shows current phase and active agents
```

---

## Agent Collaboration Patterns

### Sequential Handoffs

Within a phase, agents work in sequence:

**Planning Phase Example**:
```
Architect (designs system)
    ↓
Designer (creates UI based on architecture)
    ↓
Tech Writer (plans docs based on design)
```

### Parallel Work

Some agents can work in parallel:

**Implementation Phase Example**:
```
Developer (builds feature)
    ↓
Tester (writes tests) ← Works alongside Developer
    ↓
Reviewer (reviews code)
```

### Cross-Phase Communication

Agents can reference work from previous phases:

```
Planning Phase: Designer creates component in Figma
                    ↓
Implementation Phase: Developer references Figma design
                    ↓
Delivery Phase: Documenter includes design screenshots
```

---

## Best Practices

### When to Skip Phases

**Skip Analysis if**:
- Requirements are crystal clear
- Small feature or bug fix
- Time-sensitive work

**Skip Planning if**:
- Bug fix with obvious solution
- Tiny UI tweak
- Emergency hotfix

**Never Skip**:
- Implementation (always build and test)
- Delivery (always document and deploy properly)

### When to Use Each Workflow

```
Quick Flow:
  ✅ Bug fixes
  ✅ Typo corrections
  ✅ Small tweaks
  ✅ Emergency patches

Full BMAD:
  ✅ New features
  ✅ UI components
  ✅ API endpoints
  ✅ Refactoring

Enterprise:
  ✅ New services
  ✅ Architecture changes
  ✅ Large systems
  ✅ Infrastructure setup
```

### Document Sharding Strategy

For large projects, break documentation into phases:

```
Analysis Phase:
  - requirements.md (keep it focused)

Planning Phase:
  - architecture.md
  - design-specs.md
  - api-design.md

Implementation Phase:
  - implementation-notes.md
  - test-plan.md

Delivery Phase:
  - deployment-guide.md
  - user-guide.md
  - changelog.md
```

Load only the relevant docs per phase for faster AI responses.

---

## Customization

### Adjust Workflow Times

Edit `.claude/commands/work-ticket.md` to change phase allocation:

```markdown
Quick Flow: 5 min → 10 min
Full BMAD: 15 min → 20 min
Enterprise: 30 min → 45 min
```

### Add Custom Phases

Create your own phase:

```bash
mkdir agent/_phases/5-monitoring
```

### Modify Agent Behavior

Edit agent files to customize:
- Personality and tone
- Technical expertise
- Coding style preferences
- Documentation format

---

## Comparison: BMAD vs Lane

| Feature | Original BMAD | Lane |
|---------|---------------|------|
| **Phases** | 4 (same) | 4 (same) |
| **Agents** | 19 agents | 9 agents (simplified) |
| **Complexity** | High | Low |
| **Setup** | Complex | 5 minutes |
| **Domain** | Enterprise focus | General purpose |
| **MCP** | Multiple services | 5 core services |
| **Learning Curve** | Steep | Gentle |

Lane takes BMAD's best ideas and makes them accessible to everyone.

---

## Learn More

- 📖 [Original BMAD Methodology](https://github.com/bmad-code-org/BMAD-METHOD)
- 🔄 [Phase System Deep Dive](docs/02-PHASES.md)
- 📋 [Workflow Examples](docs/05-WORKFLOWS.md)
- 🤖 [Agent Guides](agent/_phases/)

---

**Next**: Learn about [Phase 1: Analysis](docs/02-PHASES.md) →
