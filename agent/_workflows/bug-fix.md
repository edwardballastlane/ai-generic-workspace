# Bug Fix Workflow (Quick Flow)

**Time**: ~5 minutes
**Phases**: Implementation → Delivery
**Complexity**: Low

---

## When to Use

- Fixing bugs
- Correcting errors
- Emergency hotfixes
- Small typo corrections

## Workflow Steps

### 1. Developer: Fix the Bug
```
1. Reproduce the bug
2. Identify root cause
3. Write failing test
4. Implement fix
5. Verify test passes
6. Self-review code
```

### 2. Tester: Verify Fix
```
1. Verify bug is resolved
2. Test edge cases
3. Check for regressions
4. Approve for deployment
```

### 3. Deployer: Deploy Hotfix
```
1. Deploy to staging (if available)
2. Quick smoke test
3. Deploy to production
4. Monitor for issues
```

## Example

```bash
/work-ticket "Fix broken login redirect"

# Workflow activates:
→ Developer fixes redirect logic
→ Tester verifies login works
→ Deployer creates hotfix deployment
```

## Tips

- Keep changes minimal
- Focus on the specific bug
- Don't refactor during bug fixes
- Deploy quickly to fix production issues

## Output

- Bug fix code
- Test coverage for the bug
- Deployed patch
- Brief update in changelog
