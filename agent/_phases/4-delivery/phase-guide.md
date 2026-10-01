# Phase 4: Delivery

**Purpose**: Deployment, release, and documentation finalization

## When to Use This Phase

✅ **Use Delivery When**:
- Code is reviewed and approved
- Ready for production deployment
- Release documentation needed
- User documentation updates required

❌ **Skip Delivery When**:
- Code not yet approved
- Still in testing
- Local/development only changes

## Agents in This Phase

### 🚀 Deployer
**Role**: Deploy to environments
**MCP Services**: Context7
**Output**: Deployment logs, environment configs, monitoring setup

### 📚 Documenter
**Role**: Finalize documentation
**MCP Services**: Context7
**Output**: Release notes, changelog, updated docs

## Typical Workflow

```
Deployer: Deploys to staging/production
   ↓
Documenter: Creates release documentation
   ↓
Workflow Complete ✅
```

## Entry Command

```bash
/deliver "Deploy and document the release"
```

## Success Criteria

- [ ] Deployed to target environment
- [ ] Health checks passing
- [ ] Monitoring configured
- [ ] Release notes published
- [ ] Documentation updated
- [ ] Changelog updated

## Output Documents

- `docs/deployment-log-[date].md` - Deployment details
- `CHANGELOG.md` - Updated changelog
- `docs/release-notes-[version].md` - Release notes

## Handoff Protocol

### From Deployer → Documenter

**Required outputs**:
- [ ] Deployment successful
- [ ] Health checks passing
- [ ] Monitoring active
- [ ] Rollback tested/ready

**Handoff format**:
```markdown
---
## Handoff Summary

**From**: Deployer
**To**: Documenter
**Status**: Deployed successfully

### Deployment Summary
- **Environment**: [staging | production]
- **Version**: [version number]
- **Deployed At**: [timestamp]
- **Status**: ✅ Healthy

### Deployment Details
- Build: [build number/hash]
- Duration: [deployment time]
- Method: [CI/CD pipeline used]

### Health Checks
| Service | Status | Response Time |
|---------|--------|---------------|
| API | ✅ | [Xms] |
| Database | ✅ | [Xms] |
| Cache | ✅ | [Xms] |

### Monitoring
- Dashboard: [link]
- Alerts: [configured alerts]
- Logs: [log location]

### Rollback Information
- Previous version: [version]
- Rollback command: [command]
- Rollback tested: [Yes/No]

### Changes Deployed
- [Feature 1]: [brief description]
- [Feature 2]: [brief description]
- [Fix 1]: [brief description]

### Notes for Documentation
- [Important user-facing changes]
- [Breaking changes if any]
- [New features to highlight]
---
```

### Workflow Completion

**Required outputs**:
- [ ] Release notes published
- [ ] Changelog updated
- [ ] User documentation updated
- [ ] Knowledge base updated

**Completion format**:
```markdown
---
## Workflow Complete

**Status**: ✅ Successfully Delivered

### Release Summary
- **Version**: [version]
- **Released**: [date]
- **Environment**: [environment]

### Documentation Published
- Release Notes: [link]
- Changelog: [link]
- User Guide Updates: [link]

### Features Released
- [Feature 1]: [description]
- [Feature 2]: [description]

### Bugs Fixed
- [Bug 1]: [description]
- [Bug 2]: [description]

### Known Issues
- [Issue 1] (if any)

### Metrics to Watch
- [Metric 1]: [baseline]
- [Metric 2]: [baseline]

### Stakeholder Communication
- [Who was notified]
- [Communication channels used]

---
## Workflow Statistics

| Phase | Duration | Agent(s) |
|-------|----------|----------|
| Analysis | [time] | Analyst, PO |
| Planning | [time] | Architect, Designer |
| Implementation | [time] | Developer, Tester, Reviewer |
| Delivery | [time] | Deployer, Documenter |

**Total Time**: [total]
**Decisions Made**: [count]
**Files Changed**: [count]
---
```

## Deployment Checklist

### Pre-Deployment
- [ ] Code reviewed and approved
- [ ] All tests passing
- [ ] Staging deployment successful
- [ ] Rollback plan ready
- [ ] Stakeholders notified

### During Deployment
- [ ] Follow deployment runbook
- [ ] Monitor deployment progress
- [ ] Verify health checks
- [ ] Check logs for errors
- [ ] Validate critical paths

### Post-Deployment
- [ ] Confirm all services healthy
- [ ] Smoke test critical features
- [ ] Monitor error rates
- [ ] Update status pages
- [ ] Notify stakeholders of completion

## Documentation Checklist

### Release Notes
- [ ] Version number
- [ ] Release date
- [ ] New features list
- [ ] Bug fixes list
- [ ] Breaking changes (if any)
- [ ] Migration guide (if needed)

### Changelog
- [ ] Follow Keep a Changelog format
- [ ] Categorize changes (Added, Changed, Fixed, etc.)
- [ ] Link to relevant issues/PRs

### User Documentation
- [ ] Update feature guides
- [ ] Add new screenshots
- [ ] Update API documentation
- [ ] Update FAQ if needed

## Rollback Procedures

### When to Rollback
- Critical errors in production
- Significant performance degradation
- Security vulnerabilities discovered
- Major functionality broken

### Rollback Steps
1. Identify the issue severity
2. Notify stakeholders
3. Execute rollback command
4. Verify previous version restored
5. Monitor system health
6. Document incident
7. Plan fix for next release

## Self-Learning (Automatic)

**Before every handoff in this phase**, evaluate lesson capture triggers. See [Handoff Protocol — Lesson Capture](../../_core/handoff-protocol.md#lesson-capture-at-handoff-mandatory) for the full checklist.

Quick check: Did a deployment fail for a preventable reason? Was a PR rejected for a convention? Did the user express a preference? If yes → `./scripts/capture-lesson`.

**On workflow completion**, save session memory:
```bash
./scripts/save-session-memory "Brief summary of what was accomplished"
```

## Next Steps

After delivery is complete:

1. **Monitor**: Watch metrics and logs
2. **Gather Feedback**: Collect user feedback
3. **Retrospective**: What went well? What to improve?
4. **Next Iteration**: Start next workflow cycle

```bash
/work-ticket "Next feature or improvement"
```
