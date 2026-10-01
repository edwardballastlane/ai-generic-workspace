# Phase 3: Implementation

**Purpose**: Code development, testing, and review

## When to Use This Phase

✅ **Use Implementation When**:
- Building new features
- Fixing bugs (Quick Flow)
- Refactoring code
- Performance improvements
- Any code changes

❌ **Skip Implementation When**:
- Documentation-only changes
- Design-only work
- Planning/research tasks

## Agents in This Phase

### 💻 Developer
**Role**: Write and implement code
**MCP Services**: Context7, Figma, Playwright
**Output**: Code changes, tests, implementation notes

### 🧪 Tester
**Role**: Test and validate code
**MCP Services**: Context7, Playwright
**Output**: Test results, bug reports, coverage reports

### 👁️ Reviewer
**Role**: Review code quality
**MCP Services**: Context7
**Output**: Review comments, approval status

## Typical Workflow

```
Developer: Writes code and unit tests
   ↓
Tester: Validates with comprehensive tests
   ↓ (if bugs found, return to Developer)
   ↓
Reviewer: Reviews code quality
   ↓ (if changes needed, return to Developer)
   ↓
Hand off to Delivery Phase
```

## Entry Command

```bash
/implement "Your feature or fix to implement"
```

## Success Criteria

- [ ] Code implemented per specifications
- [ ] Unit tests written and passing
- [ ] Integration tests passing
- [ ] E2E tests passing (Playwright)
- [ ] Code review approved
- [ ] Ready for deployment

## Output Documents

- Code changes in repository
- `docs/implementation-notes.md` - Implementation details
- `docs/test-results.md` - Test execution results
- `docs/review-comments.md` - Code review feedback

## Handoff Protocol

### From Developer → Tester

**Required outputs**:
- [ ] Code implementation complete
- [ ] Unit tests written
- [ ] Implementation notes provided
- [ ] Known issues documented

**Handoff format**:
```markdown
---
## Handoff Summary

**From**: Developer
**To**: Tester
**Status**: Ready for testing

### Implementation Completed
- [Feature/Fix 1]: [description]
- [Feature/Fix 2]: [description]

### Files Changed
- `src/[file1]` - [change description]
- `src/[file2]` - [change description]

### Tests Written
- Unit tests: [count] tests
- Coverage: [percentage]

### Test Scenarios to Verify
1. [Scenario 1]: [expected behavior]
2. [Scenario 2]: [expected behavior]

### Edge Cases to Test
- [Edge case 1]
- [Edge case 2]

### Known Issues
- [Issue 1] (if any)

### Environment Notes
- [Any special setup needed]
---
```

### From Tester → Developer (Bug Found)

**Trigger**: Bugs or issues found during testing

**Handoff format**:
```markdown
---
## Bug Report Handoff

**From**: Tester
**To**: Developer
**Status**: Needs fixes

### Issues Found

#### Bug #1: [Title]
**Severity**: [Critical | High | Medium | Low]
**Steps to Reproduce**:
1. [Step 1]
2. [Step 2]

**Expected**: [behavior]
**Actual**: [behavior]
**Evidence**: [screenshots/logs]

#### Bug #2: [Title]
...

### Tests Passing
- [List of passing tests]

### Tests Failing
- [Test 1]: [failure reason]

### Recommendation
Please fix the above issues and re-submit for testing.
---
```

### From Tester → Reviewer

**Required outputs**:
- [ ] All tests passing
- [ ] Coverage meets threshold
- [ ] No critical bugs
- [ ] Performance acceptable

**Handoff format**:
```markdown
---
## Handoff Summary

**From**: Tester
**To**: Reviewer
**Status**: Ready for review

### Test Summary
| Type | Passed | Failed | Skipped |
|------|--------|--------|---------|
| Unit | [n] | 0 | [n] |
| Integration | [n] | 0 | [n] |
| E2E | [n] | 0 | [n] |

### Coverage Report
- Lines: [X]%
- Branches: [X]%
- Functions: [X]%

### Issues Found & Resolved
- [Issue 1]: Fixed by Developer
- [Issue 2]: Fixed by Developer

### Performance Metrics
- [Metric 1]: [value]
- [Metric 2]: [value]

### Test Artifacts
- Screenshots: [location]
- Reports: [location]

### Recommendation
✅ Code is ready for review
---
```

### From Reviewer → Developer (Changes Requested)

**Trigger**: Code review finds issues

**Handoff format**:
```markdown
---
## Review Feedback

**From**: Reviewer
**To**: Developer
**Status**: Changes requested

### Review Summary
**Verdict**: ❌ Changes Required

### Required Changes

#### High Priority
1. [Issue]: [description]
   - File: [file:line]
   - Suggestion: [fix]

#### Medium Priority
1. [Issue]: [description]
   - File: [file:line]
   - Suggestion: [fix]

### Suggestions (Optional)
- [Suggestion 1]
- [Suggestion 2]

### Positive Notes
- [What was done well]

### Next Steps
Please address the required changes and re-submit for review.
---
```

### From Reviewer → Delivery Phase

**Required outputs**:
- [ ] Code review approved
- [ ] All issues addressed
- [ ] Documentation updated
- [ ] Ready for production

**Handoff format**:
```markdown
---
## Phase Handoff: Implementation → Delivery

**From**: Reviewer
**To**: Deployer
**Status**: ✅ Approved for deployment

### Review Summary
**Verdict**: ✅ Approved

### Code Quality
- [ ] Follows coding standards
- [ ] No security issues
- [ ] Performance acceptable
- [ ] Documentation adequate

### Implementation Summary
- Features: [list]
- Tests: [count] passing
- Coverage: [percentage]

### Deployment Notes
- [Any special deployment considerations]
- [Dependencies or migrations needed]

### Files for Deployment
- [List of changed files/packages]

### Rollback Plan
- [How to rollback if needed]
---
```

## Self-Learning (Automatic)

**Before every handoff in this phase**, evaluate lesson capture triggers. See [Handoff Protocol — Lesson Capture](../../_core/handoff-protocol.md#lesson-capture-at-handoff-mandatory) for the full checklist.

Quick check: Was I corrected? Did a build/test fail from unknown convention? Did I discover a reusable pattern? If yes → `./scripts/capture-lesson`.

## Next Phase

Once implementation is complete and approved, move to **Phase 4: Delivery**

```bash
/deliver "Deploy the approved changes"
```
