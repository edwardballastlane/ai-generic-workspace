# Brainstorm

Generate diverse ideas on: $ARGUMENTS

## Context First

Before brainstorming, gather context by asking or inferring:
- What problem or opportunity are we exploring?
- What constraints exist (budget, time, tech, team)?
- What has already been tried or considered?
- What does success look like?

## Brainstorm Agents

Six agents with isolated perspectives (spawned as separate Task agents for true divergence):

| Agent | Lens | Generates |
|-------|------|-----------|
| 💡 Innovator | No constraints, blue sky | Wild ideas, moonshots, paradigm shifts |
| 🔄 Connector | Cross-domain patterns | Analogies, borrowed solutions from other industries |
| 🔬 Simplifier | First principles | Minimal, elegant approaches |
| 👤 User Advocate | User empathy | Pain point solutions, delight moments |
| ⚡ Hacker | Ship fast | Quick wins, MVPs, 80/20 solutions |
| 🔮 Futurist | 10x thinking | Future-proof, emerging tech applications |

## Brainstorm Structure

### Round 1: Diverge (ISOLATED AGENTS)

**CRITICAL: Use Task tool to spawn 6 parallel agents with isolated contexts.**

Each agent runs independently without seeing other agents' ideas. This prevents anchoring bias and maximizes divergence.

**Spawn these 6 Task calls in parallel:**

```
Task(subagent_type="general-purpose", model="haiku", prompt="
You are the INNOVATOR - blue sky thinker with NO constraints. DO NOT use tools.

Problem: [INSERT CONTEXT]

Generate 5 WILD ideas. Moonshots, paradigm shifts. Ignore practicality.
Format: 1. [Title]: [Description]
")

Task(subagent_type="general-purpose", model="haiku", prompt="
You are the CONNECTOR - pattern matcher from other domains. DO NOT use tools.

Problem: [INSERT CONTEXT]

Generate 5 ideas borrowed from other industries (travel, finance, open source, etc).
Format: 1. [From X]: [How it applies]
")

Task(subagent_type="general-purpose", model="haiku", prompt="
You are the SIMPLIFIER - first principles thinker. DO NOT use tools.

Problem: [INSERT CONTEXT]

Generate 5 minimal solutions. Strip assumptions. What's the 1-line fix?
Format: 1. [Approach]: [Description]
")

Task(subagent_type="general-purpose", model="haiku", prompt="
You are the USER ADVOCATE - empathy-driven. DO NOT use tools.

Problem: [INSERT CONTEXT]
Users: [INSERT USER TYPE]

Generate 5 user-centric ideas. What frustrates them? What would delight them?
Format: 1. [Idea]: [Description]
")

Task(subagent_type="general-purpose", model="haiku", prompt="
You are the HACKER - ship fast, quick wins only. DO NOT use tools.

Problem: [INSERT CONTEXT]

Generate 5 ideas you could ship THIS WEEK. Include rough effort estimates.
Format: 1. [Quick win]: [Description] (~X days)
")

Task(subagent_type="general-purpose", model="haiku", prompt="
You are the FUTURIST - 10x scale, emerging tech. DO NOT use tools.

Problem: [INSERT CONTEXT]

Generate 5 future-proof ideas. What if AI could do more? What's the 5-year view?
Format: 1. [Idea]: [Description]
")
```

**After all 6 return, compile results into Round 1 output.**

### Round 2: Build (Yes, And...)

Now in single context, build on the collected ideas:
- Combine ideas from different agents
- Extend promising concepts
- Find unexpected connections

### Round 3: Cluster (Themes)

Group ideas into actionable themes:
- **Quick wins** (low effort, high value)
- **Big bets** (high effort, high potential)
- **Research needed** (promising but unknown)
- **Parked** (interesting but not now)

## Output Format

```markdown
## Brainstorm: [Topic]

### Context
- **Exploring**: [Problem/opportunity]
- **Constraints**: [Known limitations]
- **Success looks like**: [Desired outcome]

---

## Round 1: Diverge (Isolated Agents)

### 💡 Innovator
[Output from Innovator Task]

### 🔄 Connector
[Output from Connector Task]

### 🔬 Simplifier
[Output from Simplifier Task]

### 👤 User Advocate
[Output from User Advocate Task]

### ⚡ Hacker
[Output from Hacker Task]

### 🔮 Futurist
[Output from Futurist Task]

---

## Round 2: Build

### Combined Ideas
| Base Idea | + From | = Combined |
|-----------|--------|------------|
| [idea A] | [idea B] | [A+B mashup] |

### Extended Concepts
- [Idea X] → What if we also... → [Extended version]

---

## Round 3: Cluster

### 🎯 Quick Wins (Do Now)
| Idea | Effort | Impact |
|------|--------|--------|
| [idea] | Low | High |

### 🚀 Big Bets (Invest)
| Idea | Why Worth It |
|------|--------------|
| [idea] | [potential] |

### 🔍 Research Needed
| Idea | Unknown |
|------|---------|
| [idea] | [what to validate] |

### 📦 Parked (Later)
- [idea] - interesting but not now because [reason]

---

## Top 3 Recommendations

1. **[Best idea]**: [Why this one]
2. **[Second best]**: [Why this one]
3. **[Third best]**: [Why this one]

## Next Steps
1. [Concrete action]
2. [Concrete action]
3. [Concrete action]
```

## Facilitation Rules

1. **Round 1 is ISOLATED** - Agents cannot see each other's output
2. **No criticism in Round 1** - All ideas are valid during divergence
3. **Building happens in Round 2** - Cross-pollination after isolation
4. **Quantity first** - More ideas = more chances for gems

## Example Topics

Good brainstorm topics:
- "Ways to improve developer onboarding"
- "Features for our mobile app v2"
- "How to reduce build times"
- "Solutions for user churn problem"

Less suitable (use /tech-debate instead):
- "Should we use React or Vue?" (decision, not ideation)
- "Is microservices right for us?" (evaluation, not generation)

## Now Brainstorm

Topic: $ARGUMENTS

1. Gather context first (ask if needed)
2. Spawn 6 parallel Task agents for Round 1
3. Compile results and run Rounds 2-3 in single context
4. End with clustered recommendations and concrete next steps
