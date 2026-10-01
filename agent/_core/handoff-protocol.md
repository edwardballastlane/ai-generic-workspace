# Handoff Protocol

Formal procedures for transitioning work between agents, ensuring context preservation and smooth workflow continuation.

## Handoff Principles

1. **Complete outputs before handoff** - Never hand off incomplete work
2. **Document decisions** - Record rationale for all choices made
3. **Preserve context** - Next agent receives full history
4. **Validate readiness** - Check handoff criteria before proceeding
5. **Explicit signaling** - Use standard format to signal completion

## Standard Handoff Format

When an agent completes their work, they must produce:

```markdown
---
## Handoff Summary

**From**: [current agent]
**To**: [next agent(s)]
**Phase**: [current] → [next]
**Status**: Ready for handoff

### Completed Work
- [Output 1]: [description]
- [Output 2]: [description]

### Key Decisions
| Decision | Rationale | Impact |
|----------|-----------|--------|
| [decision] | [why] | [what it affects] |

### Context for Next Agent
[Brief summary of what the next agent needs to know]

### Open Questions
- [Any unresolved items for next agent to address]

### Blockers
- [None / List any blockers]

---
```

## Handoff Criteria by Agent

### Analyst → Product Owner

**Required outputs**:
- [ ] Research notes completed
- [ ] Market analysis done
- [ ] Technical constraints identified
- [ ] Stakeholder input gathered

**Validation**:
```
✓ All research questions answered
✓ Constraints documented
✓ No major unknowns remaining
```

### Product Owner → Architect

**Required outputs**:
- [ ] User stories defined
- [ ] Acceptance criteria written
- [ ] Priorities established
- [ ] Scope boundaries clear

**Validation**:
```
✓ Stories follow INVEST criteria
✓ Acceptance criteria are testable
✓ MVP scope is defined
```

### Architect → Designer

**Required outputs**:
- [ ] System architecture documented
- [ ] Technology decisions made
- [ ] API contracts defined
- [ ] Data models designed

**Validation**:
```
✓ Architecture supports requirements
✓ Technology choices justified
✓ Scalability considered
✓ Security addressed
```

### Architect → Developer (Quick Flow)

**Required outputs**:
- [ ] Task clearly defined
- [ ] Approach documented
- [ ] Files to modify identified
- [ ] Testing requirements stated

**Validation**:
```
✓ Developer has enough context
✓ Scope is contained
✓ No architectural questions
```

### Designer → Developer

**Required outputs**:
- [ ] Design specifications complete
- [ ] Component library defined
- [ ] Interaction patterns documented
- [ ] Responsive requirements clear

**Validation**:
```
✓ All screens designed
✓ Edge cases covered
✓ Accessibility considered
✓ Design tokens defined
```

### Developer → Tester

**Required outputs**:
- [ ] Code implementation complete
- [ ] Unit tests written
- [ ] Implementation notes provided
- [ ] Known issues documented

**Validation**:
```
✓ Code compiles/runs
✓ Basic functionality works
✓ No obvious bugs
✓ Tests passing
```

### Tester → Reviewer

**Required outputs**:
- [ ] Test results documented
- [ ] Coverage report generated
- [ ] Bug reports filed
- [ ] Performance metrics captured

**Validation**:
```
✓ All test cases executed
✓ Coverage meets threshold
✓ No critical bugs open
✓ Performance acceptable
```

### Reviewer → Deployer

**Required outputs**:
- [ ] Code review completed
- [ ] All comments addressed
- [ ] Security review done
- [ ] Approval granted

**Validation**:
```
✓ No blocking issues
✓ Code meets standards
✓ Documentation updated
✓ Ready for production
```

### Deployer → Documenter

**Required outputs**:
- [ ] Deployment successful
- [ ] Environment configured
- [ ] Monitoring active
- [ ] Rollback tested

**Validation**:
```
✓ Application running
✓ Health checks passing
✓ Logs accessible
✓ Alerts configured
```

## Handoff Sequences

### Quick Flow

```
Developer ──────────────────────────────> Tester ──> Deployer
           (implementation-notes.md)           (test-results.md)
```

### Full BMAD

```
Architect ──> Designer ──> Developer ──> Tester ──> Deployer ──> Documenter
          ↘           ↗
           Tech Writer
```

### Enterprise

```
Analyst ──> Product Owner ──> Architect ──> Designer ──> Developer ...
                                       ↘            ↗
                                        Tech Writer
```

## Handling Handoff Failures

### Incomplete Handoff

```markdown
IF outputs incomplete:
  1. Signal blocked status
  2. Document what's missing
  3. Request additional time or help
  4. Do NOT proceed to next agent
```

### Rejected Handoff

```markdown
IF next agent rejects handoff:
  1. Document rejection reason
  2. Return to previous agent
  3. Address rejection issues
  4. Re-attempt handoff
```

### Emergency Handoff

```markdown
IF urgent bypass needed:
  1. Document reason for bypass
  2. Note incomplete items
  3. Proceed with explicit user approval
  4. Schedule follow-up for missing items
```

## Parallel Handoffs

Some phases support parallel work:

```
Architect ──┬──> Designer
            │
            └──> Tech Writer

Both receive handoff simultaneously.
Developer waits for both to complete.
```

### Parallel Handoff Format

```markdown
---
## Parallel Handoff Summary

**From**: Architect
**To**: Designer, Tech Writer (parallel)
**Sync Point**: Developer

### For Designer
- Focus: UI/UX design
- Key inputs: [list]
- Expected outputs: [list]

### For Tech Writer
- Focus: Technical documentation
- Key inputs: [list]
- Expected outputs: [list]

### Convergence
Both must complete before Developer can start.
---
```

## Context Preservation

### What to Preserve

| Category | Examples |
|----------|----------|
| **Decisions** | Technology choices, design patterns |
| **Constraints** | Budget, timeline, technical limits |
| **Assumptions** | User behavior, system load |
| **Risks** | Identified issues, mitigations |
| **Dependencies** | External systems, APIs |

### Preservation Format

```yaml
context:
  task_id: "unique-id"
  started: "2025-01-15"

  decisions:
    - id: D001
      decision: "Use PostgreSQL"
      agent: architect
      phase: 2
      rationale: "Team expertise, ACID compliance"

  constraints:
    - type: timeline
      value: "2 weeks"
    - type: budget
      value: "No new services"

  risks:
    - id: R001
      description: "Third-party API rate limits"
      mitigation: "Implement caching"
      owner: developer
```

## Rollback Procedures

### Rollback to Previous Agent

```markdown
1. Document rollback reason
2. Preserve current agent's partial work
3. Notify previous agent of return
4. Provide feedback on what needs change
5. Previous agent resumes with feedback
```

### Rollback to Previous Phase

```markdown
1. Document phase failure reason
2. Archive all phase outputs
3. Reset phase status
4. Re-enter phase with learned context
5. Previous agents resume work
```

## Lesson Capture at Handoff

A `PostToolUse` hook automatically prompts for lesson capture when `update-session next-agent` or `update-session status completed` runs. Follow the prompt when it appears.

**When to capture** (the hook reminds you, just answer honestly):
- User corrected your approach
- Build/test failed from unknown project convention
- Discovered a reusable pattern or anti-pattern
- PR rejected for a convention violation

**How to capture:**
```bash
./scripts/capture-lesson --project <project> --category <cat> --agent <agent> --severity <level> "lesson"
```

Categories: `code-quality`, `security`, `testing`, `architecture`, `git`, `performance`
Severity: `critical`, `high`, `medium`, `low`

Captured lessons are auto-injected into future sessions via the `inject-context.sh` hook.

## Related

- [Orchestrator](orchestrator.md) - Manages handoff execution
- [Agent Registry](agent-registry.md) - Agent capabilities
- [Context Manager](context-manager.md) - Context storage
