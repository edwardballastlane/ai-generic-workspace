# Phase 2: Planning

**Purpose**: Design, architecture, and specification

## When to Use This Phase

✅ **Use Planning When**:
- New feature development
- Architecture decisions needed
- UI/UX design required
- Technical specifications needed
- Full BMAD or Enterprise workflow

❌ **Skip Planning When**:
- Bug fixes (Quick Flow)
- Minor changes
- Requirements already have technical specs
- Time-critical hotfixes

## Agents in This Phase

### 🏗️ Architect
**Role**: Design technical architecture
**MCP Services**: Context7
**Output**: Architecture docs, API specs, data models

### 🎨 Designer
**Role**: Create UI/UX designs
**MCP Services**: Figma
**Output**: Design specs, component library, Figma links

### 📝 Tech Writer
**Role**: Document specifications
**MCP Services**: Context7
**Output**: Technical docs, API docs, user guides

## Typical Workflow

```
         ┌──> Designer: Creates UI/UX designs
         │
Architect ──> (parallel work possible)
         │
         └──> Tech Writer: Documents specifications

         ↓ (all converge)

Developer: Receives complete specifications
```

## Entry Command

```bash
/plan "Your feature or system to design"
```

## Success Criteria

- [ ] Architecture documented
- [ ] Technology decisions made
- [ ] API contracts defined
- [ ] UI designs complete (if applicable)
- [ ] Technical documentation ready
- [ ] Ready for implementation

## Output Documents

- `docs/architecture-[feature].md` - Technical architecture
- `docs/api-spec-[feature].md` - API specifications
- `docs/design-spec-[feature].md` - Design specifications
- `docs/data-model-[feature].md` - Data models

## Handoff Protocol

### From Architect → Designer & Tech Writer (Parallel)

**Required outputs**:
- [ ] System architecture documented
- [ ] Technology decisions made
- [ ] API contracts defined
- [ ] Data models designed

**Handoff format**:
```markdown
---
## Parallel Handoff Summary

**From**: Architect
**To**: Designer, Tech Writer (parallel)
**Sync Point**: Developer

### For Designer
**Focus**: UI/UX based on architecture
**Key inputs**:
- System architecture overview
- User interaction points
- Data flow diagrams
- Component requirements

**Expected outputs**:
- Design specifications
- Component library
- Interaction patterns

### For Tech Writer
**Focus**: Technical documentation
**Key inputs**:
- Architecture document
- API specifications
- Data models

**Expected outputs**:
- API documentation
- Developer guides
- Integration notes

### Architecture Decisions
| Decision | Rationale | Impact |
|----------|-----------|--------|
| [decision] | [why] | [effect] |

### Convergence
Both Designer and Tech Writer must complete before Developer starts.
---
```

### From Designer → Developer

**Required outputs**:
- [ ] All screens designed
- [ ] Component library defined
- [ ] Design tokens documented
- [ ] Responsive specs provided

**Handoff format**:
```markdown
---
## Handoff Summary

**From**: Designer
**To**: Developer
**Status**: Ready for implementation

### Designs Completed
- [Screen/Component 1]: [Figma link]
- [Screen/Component 2]: [Figma link]

### Design Tokens
- Colors: [reference]
- Typography: [reference]
- Spacing: [reference]

### Interaction Patterns
- [Pattern 1]: [description]
- [Pattern 2]: [description]

### Responsive Breakpoints
| Breakpoint | Width | Notes |
|------------|-------|-------|
| Mobile | 320px | ... |
| Tablet | 768px | ... |
| Desktop | 1024px+ | ... |

### Notes for Developer
- [Important implementation detail]
---
```

### From Tech Writer → Developer

**Required outputs**:
- [ ] API documentation complete
- [ ] Developer guides ready
- [ ] Integration notes provided

**Handoff format**:
```markdown
---
## Handoff Summary

**From**: Tech Writer
**To**: Developer
**Status**: Documentation ready

### Documentation Completed
- API Reference: [link]
- Developer Guide: [link]
- Integration Guide: [link]

### Key Points
- [Important note 1]
- [Important note 2]

### Examples Provided
- [Example 1]: [description]
- [Example 2]: [description]
---
```

### Phase Handoff: Planning → Implementation

**Required outputs**:
- [ ] Architecture finalized
- [ ] Designs complete
- [ ] Documentation ready
- [ ] All decisions documented

**Handoff format**:
```markdown
---
## Phase Handoff: Planning → Implementation

**From**: Planning Phase (Architect, Designer, Tech Writer)
**To**: Developer
**Status**: Ready for implementation

### Planning Artifacts
- `docs/architecture.md` - System architecture
- `docs/api-spec.md` - API specifications
- `docs/design-spec.md` - UI designs
- `docs/documentation.md` - Technical docs

### Key Decisions Summary
1. [Decision 1]: [brief rationale]
2. [Decision 2]: [brief rationale]

### Implementation Priority
1. [Highest priority item]
2. [Second priority]
3. [Third priority]

### Constraints & Considerations
- [Constraint 1]
- [Consideration 2]

### Success Metrics
- [Metric 1]
- [Metric 2]
---
```

## Self-Learning (Automatic)

**Before every handoff in this phase**, evaluate lesson capture triggers. See [Handoff Protocol — Lesson Capture](../../_core/handoff-protocol.md#lesson-capture-at-handoff-mandatory) for the full checklist.

Quick check: Was I corrected? Did something fail unexpectedly? Did I discover a project convention? If yes → `./scripts/capture-lesson`.

## Next Phase

Once planning is complete, move to **Phase 3: Implementation**

```bash
/implement "Based on planning, build the feature"
```
