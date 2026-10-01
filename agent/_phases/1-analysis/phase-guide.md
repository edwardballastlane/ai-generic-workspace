# Phase 1: Analysis

**Purpose**: Research, discovery, and requirements gathering

## When to Use This Phase

✅ **Use Analysis When**:
- Building something completely new
- Problem space is unclear
- Need to research options
- Exploring multiple solutions
- Stakeholder requirements unclear

❌ **Skip Analysis When**:
- Bug fixes
- Well-defined features
- Requirements are crystal clear
- Time-sensitive work

## Agents in This Phase

### 🔍 Analyst
**Role**: Research and discovery
**MCP Services**: Context7
**Output**: Research findings, technical options, recommendations

### 📊 Product Owner
**Role**: Define requirements and user stories
**MCP Services**: Context7
**Output**: User stories, acceptance criteria, feature specs

## Typical Workflow

```
1. Analyst: Researches problem space and technical options
   ↓
2. Product Owner: Defines requirements based on research
   ↓
3. Hand off to Planning Phase
```

## Entry Command

```bash
/analyze "Your problem or question"
```

## Success Criteria

- [ ] Problem is well-understood
- [ ] Technical options researched
- [ ] User stories defined
- [ ] Acceptance criteria clear
- [ ] Ready for planning

## Output Documents

- `docs/research-[date].md` - Research findings
- `docs/requirements-[date].md` - Requirements document
- `docs/user-stories-[date].md` - User stories

## Handoff Protocol

### From Analyst → Product Owner

**Required outputs**:
- [ ] Research notes completed
- [ ] Technical options analyzed
- [ ] Constraints identified
- [ ] Recommendations provided

**Handoff format**:
```markdown
---
## Handoff Summary

**From**: Analyst
**To**: Product Owner
**Status**: Ready for requirements definition

### Research Completed
- [Research topic 1]: [findings]
- [Research topic 2]: [findings]

### Technical Options
| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| [opt1] | ... | ... | [Yes/No/Maybe] |

### Constraints Identified
- [Constraint 1]
- [Constraint 2]

### Open Questions for Product Owner
- [Question 1]
- [Question 2]
---
```

### From Product Owner → Planning Phase

**Required outputs**:
- [ ] User stories defined (INVEST criteria)
- [ ] Acceptance criteria written
- [ ] Priorities established
- [ ] Scope boundaries clear

**Handoff format**:
```markdown
---
## Phase Handoff: Analysis → Planning

**From**: Product Owner
**To**: Architect
**Status**: Ready for technical planning

### User Stories Ready
- [US-001]: [story summary]
- [US-002]: [story summary]

### Priority Order
1. [Highest priority item]
2. [Second priority]

### Scope Boundaries
- **In scope**: [list]
- **Out of scope**: [list]

### Key Decisions
- [Decision 1]: [rationale]
---
```

## Self-Learning (Automatic)

**Before every handoff in this phase**, evaluate lesson capture triggers. See [Handoff Protocol — Lesson Capture](../../_core/handoff-protocol.md#lesson-capture-at-handoff-mandatory) for the full checklist.

Quick check: Was I corrected? Did something fail unexpectedly? Did I discover a project convention? If yes → `./scripts/capture-lesson`.

## Next Phase

Once analysis is complete, move to **Phase 2: Planning**

```bash
/plan "Based on analysis, plan the implementation"
```
