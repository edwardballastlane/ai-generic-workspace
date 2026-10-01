# Agent Guide

**How to work effectively with AI agents in this workspace**

---

## Overview

Lane uses **9 specialized agents** organized into **4 development phases**. Each agent is an expert in their domain and knows when to hand off work to the next agent.

---

## Quick Reference

### Phase 1: Analysis
| Agent | Purpose | When to Use |
|-------|---------|-------------|
| 🔍 **Analyst** | Research and discovery | Exploring new domains |
| 📊 **Product Owner** | Requirements and stories | Defining features |

### Phase 2: Planning
| Agent | Purpose | When to Use |
|-------|---------|-------------|
| 🏗️ **Architect** | System design | Technical decisions |
| 🎨 **Designer** | UX/UI design | Visual work, Figma |
| 📝 **Tech Writer** | Documentation planning | Doc structure |

### Phase 3: Implementation
| Agent | Purpose | When to Use |
|-------|---------|-------------|
| 💻 **Developer** | Code implementation | Writing code |
| 🧪 **Tester** | Testing and QA | Test creation |
| 👀 **Reviewer** | Code review | Quality checks |

### Phase 4: Delivery
| Agent | Purpose | When to Use |
|-------|---------|-------------|
| 🚀 **Deployer** | CI/CD and deployment | Shipping code |
| 📚 **Documenter** | Final documentation | User guides |

---

## How Agents Work

### 1. Agent Activation

Agents are activated by phase commands:

```bash
# Activate Analysis phase agents
/analyze "Build a chat app"
# → Analyst and Product Owner become active

# Activate Planning phase agents
/plan "Design user dashboard"
# → Architect, Designer, Tech Writer become active

# Activate Implementation phase agents
/implement "Build authentication"
# → Developer, Tester, Reviewer become active

# Activate Delivery phase agents
/deliver "Deploy to production"
# → Deployer and Documenter become active
```

### 2. Agent Handoffs

Agents hand off work in sequence:

**Example: Planning Phase**
```
1. Architect designs the system architecture
   ↓ (hands off specs)
2. Designer creates UI based on architecture
   ↓ (hands off designs)
3. Tech Writer plans documentation structure
```

### 3. MCP Tool Usage

Agents use MCP services when needed:

**Context7** (Up-to-date documentation):
- Architect: Research architecture patterns
- Developer: Find API documentation
- Deployer: Check deployment guides

**Figma** (Design integration):
- Designer: Create and review designs
- Developer: Extract component specs
- Documenter: Include design screenshots

---

## Working with Each Agent

### 🔍 Analyst

**Expertise**: Research, market analysis, requirements discovery

**When to Use**:
- Exploring new problem spaces
- Understanding user needs
- Researching technical options
- Competitive analysis

**Tools**:
- Web search
- Context7 for industry docs
- Documentation analysis

**Example Interaction**:
```
You: "I need to build a real-time collaboration feature"

Analyst:
1. Researches real-time tech (WebSocket, WebRTC, etc.)
2. Analyzes pros/cons of each approach
3. Identifies requirements and constraints
4. Documents findings

Output: Research document with recommendations
```

**Best Practices**:
- Give broad problem statements
- Let them explore options
- They'll narrow down to specific solutions

---

### 📊 Product Owner

**Expertise**: Feature definition, user stories, acceptance criteria

**When to Use**:
- Defining new features
- Writing user stories
- Setting acceptance criteria
- Prioritizing requirements

**Tools**:
- User story templates
- Figma for user flow analysis

**Example Interaction**:
```
You: "Users need to edit their profiles"

Product Owner:
1. Breaks down into user stories
2. Defines acceptance criteria
3. Identifies edge cases
4. Prioritizes requirements

Output: User stories with acceptance criteria
```

**Best Practices**:
- Focus on user value
- Let them break down requirements
- They'll handle the "what" not the "how"

---

### 🏗️ Architect

**Expertise**: System design, technical decisions, architecture patterns

**When to Use**:
- Designing new systems
- Making tech stack choices
- Defining APIs
- Planning data models

**Tools**:
- Architecture diagrams
- Context7 for framework docs
- Design patterns

**Example Interaction**:
```
You: "Design the backend for a social media app"

Architect:
1. Designs system architecture
2. Chooses tech stack
3. Defines API structure
4. Plans data models
5. Identifies scalability concerns

Output: Technical specification with diagrams
```

**Best Practices**:
- Provide constraints (scale, budget, team size)
- Ask about tradeoffs
- They'll justify technical decisions

---

### 🎨 Designer

**Expertise**: UX/UI design, prototyping, design systems

**When to Use**:
- Creating visual designs
- Building prototypes
- Defining design systems
- User experience work

**Tools**:
- Figma MCP integration
- Design patterns
- Component libraries

**Example Interaction**:
```
You: "Design a user dashboard"

Designer:
1. Creates Figma mockups
2. Defines component structure
3. Specifies interactions
4. Documents design tokens

Output: Figma designs with specifications
```

**Best Practices**:
- Share design references
- Discuss user flows first
- They work with Figma files directly

---

### 📝 Tech Writer

**Expertise**: Documentation planning, content structure, writing guides

**When to Use**:
- Planning documentation
- Structuring content
- Defining doc requirements
- Creating templates

**Tools**:
- Documentation templates
- Context7 for doc standards
- Markdown guides

**Example Interaction**:
```
You: "Plan documentation for our API"

Tech Writer:
1. Defines doc structure
2. Creates content outline
3. Plans examples and tutorials
4. Sets up templates

Output: Documentation plan and templates
```

**Best Practices**:
- Share target audience
- Discuss documentation goals
- They plan structure, others write content

---

### 💻 Developer

**Expertise**: Code implementation, best practices, debugging

**When to Use**:
- Writing code
- Implementing features
- Fixing bugs
- Refactoring

**Tools**:
- Programming languages
- Context7 for API docs
- Figma for design specs

**Example Interaction**:
```
You: "Implement user authentication"

Developer:
1. Writes authentication code
2. Follows security best practices
3. Integrates with designs
4. Documents code
5. Creates unit tests

Output: Working code with tests
```

**Best Practices**:
- Provide technical specs from Architect
- Share design files from Designer
- They'll follow established patterns

---

### 🧪 Tester

**Expertise**: Test creation, QA, test automation

**When to Use**:
- Writing tests
- Testing features
- Finding edge cases
- Setting up test automation

**Tools**:
- Testing frameworks
- Context7 for testing docs
- Coverage tools

**Example Interaction**:
```
You: "Test the authentication system"

Tester:
1. Writes unit tests
2. Creates integration tests
3. Identifies edge cases
4. Tests error scenarios
5. Generates coverage report

Output: Comprehensive test suite
```

**Best Practices**:
- Share acceptance criteria
- Discuss edge cases
- They'll ensure quality

---

### 👀 Reviewer

**Expertise**: Code review, quality standards, best practices

**When to Use**:
- Reviewing code
- Ensuring quality
- Checking standards
- Suggesting improvements

**Tools**:
- Linting tools
- Context7 for coding standards
- Static analysis

**Example Interaction**:
```
You: "Review this authentication code"

Reviewer:
1. Checks code quality
2. Verifies security practices
3. Suggests improvements
4. Validates tests
5. Ensures consistency

Output: Review feedback and suggestions
```

**Best Practices**:
- Let them review after Developer
- They'll catch issues early
- Focus on quality over speed

---

### 🚀 Deployer

**Expertise**: CI/CD, deployment, infrastructure, DevOps

**When to Use**:
- Setting up deployment
- Configuring CI/CD
- Infrastructure work
- Release automation

**Tools**:
- Docker, Kubernetes
- CI/CD platforms
- Context7 for platform docs

**Example Interaction**:
```
You: "Deploy to AWS with CI/CD"

Deployer:
1. Creates Dockerfile
2. Sets up CI/CD pipeline
3. Configures AWS resources
4. Implements deployment strategy
5. Sets up monitoring

Output: Deployment configs and automation
```

**Best Practices**:
- Share infrastructure constraints
- Discuss deployment strategy
- They'll handle DevOps complexity

---

### 📚 Documenter

**Expertise**: Final documentation, user guides, API docs, release notes

**When to Use**:
- Writing user documentation
- Creating API references
- Writing release notes
- Final polish

**Tools**:
- Documentation generators
- Context7 for doc frameworks
- Markdown/HTML

**Example Interaction**:
```
You: "Create user guide for the app"

Documenter:
1. Writes user guide
2. Creates API documentation
3. Writes release notes
4. Adds screenshots
5. Generates final docs

Output: Complete documentation
```

**Best Practices**:
- Share target audience
- Provide feature list
- They'll make it user-friendly

---

## Agent Collaboration Patterns

### Pattern 1: Sequential Flow
Agents work one after another:

```
Architect → Designer → Tech Writer
```

**When**: Each agent needs previous agent's output

### Pattern 2: Parallel Work
Agents work simultaneously:

```
Developer (feature A) ║ Developer (feature B)
```

**When**: Independent work items

### Pattern 3: Iterative Loops
Agents revisit previous work:

```
Developer → Tester → Developer (fixes) → Tester (retest)
```

**When**: Finding and fixing issues

### Pattern 4: Cross-Phase References
Agents reference work from other phases:

```
Planning: Designer (creates Figma)
              ↓
Implementation: Developer (reads Figma)
              ↓
Delivery: Documenter (screenshots from Figma)
```

**When**: Work builds across phases

---

## Tips for Effective Collaboration

### 1. Use the Right Workflow

```bash
# Bug fix → Quick Flow
/work-ticket "Fix login redirect"

# Feature → Full BMAD
/work-ticket "Add user profiles"

# System → Enterprise
/work-ticket "Build microservices architecture"
```

### 2. Provide Context

❌ Bad:
```
"Make it better"
```

✅ Good:
```
"Improve login performance - currently takes 3s, target is <500ms"
```

### 3. Let Agents Specialize

❌ Don't ask Developer to design
❌ Don't ask Designer to deploy

✅ Let each agent do their job:
- Designer → designs
- Developer → codes
- Deployer → deploys

### 4. Trust the Handoffs

Agents know when to hand off work:

```
Developer: "I've completed the code. Handing off to Tester."
Tester: "Tests written and passing. Handing off to Reviewer."
Reviewer: "Code reviewed and approved. Ready for delivery."
```

### 5. Use MCP Tools

Agents will use Context7 and Figma automatically:

```
Architect: "Checking latest Next.js patterns..." [Context7]
Designer: "Creating component in Figma..." [Figma]
Developer: "Looking up React Query docs..." [Context7]
```

---

## Common Scenarios

### Scenario 1: Starting a New Feature

```bash
/work-ticket "Add dark mode toggle"

# Full BMAD workflow activated:
1. Architect: Designs state management approach
2. Designer: Creates dark theme in Figma
3. Developer: Implements toggle and theme switching
4. Tester: Tests theme switching in all components
5. Reviewer: Reviews implementation
6. Deployer: Deploys to production
7. Documenter: Adds toggle to user guide
```

### Scenario 2: Fixing a Bug

```bash
/work-ticket "Fix broken image upload"

# Quick Flow activated:
1. Developer: Identifies and fixes issue
2. Tester: Creates test for bug
3. Reviewer: Quick review
4. Deployer: Hotfix deployment
```

### Scenario 3: Building a New System

```bash
/work-ticket "Build analytics dashboard"

# Enterprise workflow activated:
1. Analyst: Researches analytics tools and patterns
2. Product Owner: Defines dashboard requirements
3. Architect: Designs data pipeline and API
4. Designer: Creates dashboard UI in Figma
5. Tech Writer: Plans documentation structure
6. Developer: Builds frontend and backend
7. Tester: Creates comprehensive test suite
8. Reviewer: Reviews all code
9. Deployer: Sets up production deployment
10. Documenter: Writes complete user guide
```

---

## Customizing Agents

### Modify Agent Behavior

Edit agent files in `agent/_phases/`:

```markdown
agent/_phases/3-implementation/developer.md
---
personality: concise
expertise:
  - typescript
  - react
  - node.js
coding_style: functional
prefer_libraries:
  - react-query
  - zustand
---
```

### Add Custom Agents

Create new agent files:

```bash
# Add a data scientist agent
echo "..." > agent/_phases/2-planning/data-scientist.md
```

### Change Phase Assignments

Move agents to different phases:

```bash
# Move Tech Writer to Delivery phase
mv agent/_phases/2-planning/tech-writer.md \
   agent/_phases/4-delivery/tech-writer.md
```

---

## Troubleshooting

### Agent Not Responding

**Check**:
1. Are you in the right phase?
   ```bash
   /status  # Check current phase
   ```

2. Is the agent activated?
   ```bash
   /plan  # Activate Planning phase agents
   ```

### Wrong Agent Activated

**Fix**:
```bash
# Switch to correct phase
/implement  # For Developer, Tester, Reviewer
/deliver    # For Deployer, Documenter
```

### Agent Needs More Context

**Provide**:
- Technical specs
- Design files
- Requirements docs
- Example code

---

## Learn More

- 📖 [Methodology Guide](METHODOLOGY.md)
- 🔄 [Phase System](docs/02-PHASES.md)
- 📋 [Workflow Examples](docs/05-WORKFLOWS.md)
- 🔧 [Customization Guide](docs/04-CUSTOMIZATION.md)

---

**Ready to start?** Try `/work-ticket "Your first task"` →
