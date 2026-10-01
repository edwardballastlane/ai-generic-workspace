# Tech Debate

Initiate structured technical debate on: $ARGUMENTS

## Context Gathering

First, understand the decision:
- What problem are we solving?
- What are the constraints (time, team, infrastructure)?
- What does the codebase currently look like?
- Are there existing patterns we should follow or break?

## Guiding Principles

Before diving into specific solutions, consider these architectural questions:

| Principle | Question |
|-----------|----------|
| **Data Lifecycle** | Where in the data lifecycle should this work happen? (ingestion → storage → retrieval → rendering) |
| **Do Once vs Repeatedly** | Can this be computed once instead of on every request? |
| **Shift Left** | What's the earliest point in the pipeline we can solve this? |
| **Ownership** | Who should be responsible for this transformation? |
| **Data Locality** | Where does this data originate, and can we fix it there? |
| **Root Cause** | Are we treating a symptom or the actual cause? |

## Debate Agents

### 🚀 Pragmatist (Ship It)
- Optimizes for: Time to production, team capabilities, reducing unknowns
- Asks: "What gets us live with acceptable quality?"
- Bias: Working software over perfect architecture

### ⚖️ Purist (Do It Right)
- Optimizes for: Long-term maintainability, correctness, scalability
- Asks: "What won't we regret in 2 years?"
- Bias: Proper foundations over quick wins

### 🔍 Skeptic (Poke Holes)
- Optimizes for: Finding blind spots, unstated assumptions
- Asks: "What are you not considering? What breaks under stress?"
- Bias: Assumes everyone is overconfident

### 🔧 Operator (Run It)
- Optimizes for: Observability, failure modes, on-call experience
- Asks: "How does this fail at 3am? Can we debug it?"
- Bias: Operability over elegance

### 🏗️ Architect (System Thinker)
- Optimizes for: Root cause solutions, system-wide impact, data flow
- Asks: "Where in the pipeline should this really be solved? Are we fixing a symptom or the cause?"
- Bias: Upstream fixes over downstream patches
- Considers: Data lifecycle (ingestion → storage → retrieval → rendering)

### 📋 Synthesizer (Find the Path)
- Weighs arguments by evidence strength
- Identifies the REAL decision (often different from stated question)
- Surfaces unresolved tensions honestly
- Proposes concrete next steps

## Debate Structure

### Round 1: Opening Positions (each agent)
- State position clearly
- Provide concrete evidence (numbers, code examples, experiences)
- Acknowledge constraints

### Round 2: Rebuttals
- Agents respond to each other directly
- Challenge weak arguments
- Refine positions based on new information

### Round 3: Synthesis
- Synthesizer integrates all perspectives
- Frame the actual decision clearly
- Provide decision framework (if X then Y, if A then B)
- List unresolved tensions
- Concrete action items

## Output Format

Use this debate transcript format:

```markdown
## Tech Debate: [Topic]

### Context
- **Problem**: [What we're solving]
- **Constraints**: [Time, team, infra limitations]
- **Current State**: [Relevant codebase context]

---

## Round 1: Opening Positions

### 🚀 Pragmatist
[Position with evidence]

### ⚖️ Purist
[Position with evidence]

### 🔍 Skeptic
[Position with evidence]

### 🔧 Operator
[Position with evidence]

### 🏗️ Architect
[Position with evidence - focusing on data lifecycle and upstream solutions]

---

## Round 2: Rebuttals

### 🚀 Pragmatist responds to Purist
[Rebuttal]

### ⚖️ Purist responds to Pragmatist
[Rebuttal]

### 🔍 Skeptic challenges both
[Challenges]

### 🔧 Operator reality check
[Operational concerns]

### 🏗️ Architect system view
[Upstream/pipeline alternatives, root cause analysis]

---

## Round 3: Synthesis

### 📋 Synthesizer

**The Real Decision**: [Often different from the stated question]

**Decision Framework**:
- If [condition X] → [approach Y]
- If [condition A] → [approach B]

**Unresolved Tensions**:
- [Tension 1]
- [Tension 2]

**Recommended Path**:
[Clear recommendation with rationale]

**Action Items**:
1. [Concrete next step]
2. [Concrete next step]
3. [Concrete next step]
```

Include code snippets where relevant. End with actionable next steps, not vague recommendations.
