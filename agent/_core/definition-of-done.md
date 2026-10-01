# Definition of Done

Shared completion criteria for all Lane agents. Every agent references this file to ensure consistent quality across phases.

## AI-Aware DoD Checklist

A task is **done** when all applicable items are satisfied:

### Structural Review
- [ ] Work reviewed by a different role (enforced by the workflow sequence: developer → tester → reviewer)
- [ ] No role marks its own output as "complete" without the next role validating it

### Testing
- [ ] Tests generated or expanded to cover new/changed behavior
- [ ] Edge cases and error paths verified — especially for AI-generated code, which tends to cover happy paths only
- [ ] Build passes with no new errors

### Decisions
- [ ] Significant technical decisions documented via ADR (see template below)
- [ ] Minor decisions captured in commit messages or handoff notes

### Code Clarity
- [ ] Non-obvious code has WHY comments (e.g., `// Workaround for Safari flexbox bug`)
- [ ] Public interfaces (APIs, exported functions, shared types) summarized in commit or handoff notes

### Scope Discipline
- [ ] Implementation stays within the boundaries of the original task
- [ ] If scope expansion is needed, the agent **asks the user** before proceeding
- [ ] No unrequested refactoring, feature additions, or "while I'm here" changes

---

## ADR Template

Use this template when a decision is significant enough to affect future work. Create ADRs in the project's `docs/` directory (e.g., `docs/adr/001-choose-auth-strategy.md`).

```markdown
# ADR-[number]: [Title]

**Status**: Proposed | Accepted | Deprecated | Superseded by ADR-[number]
**Date**: [YYYY-MM-DD]
**Decision-maker**: [Agent or user who decided]

## Context

What is the problem or situation that requires a decision?

## Decision

What was decided?

## Consequences

### Positive
- [Benefit 1]
- [Benefit 2]

### Negative
- [Trade-off 1]
- [Trade-off 2]

### Neutral
- [Side effect that is neither good nor bad]
```

### When to Write an ADR

- Choosing between technologies or libraries
- Changing data models or database schemas
- Defining API contracts that other systems depend on
- Selecting architecture patterns (caching strategy, auth mechanism, etc.)
- Any decision the team might question in 3 months

### When NOT to Write an ADR

- Implementation details that only affect one function
- Style choices covered by linting rules
- Temporary workarounds with a clear TODO

---

## Who References This File

| Agent | Uses |
|-------|------|
| **Architect** | ADR template for significant decisions |
| **Developer** | Scope discipline, WHY comments, ADR for implementation decisions |
| **Tester** | AI-code test expansion, edge case verification |
| **Reviewer** | Full DoD checklist as review gate |
| **Deployer** | Confirms DoD satisfied before delivery |

## Related

- [Context Manager](context-manager.md) — Context layers and token discipline
- [Handoff Protocol](handoff-protocol.md) — Transition procedures between agents
