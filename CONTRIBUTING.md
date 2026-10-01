# Contributing to Lane

Thank you for your interest in contributing! This guide will help you get started.

## Ways to Contribute

### 1. **Report Bugs**
Found a bug? [Open an issue](https://your-git-host.example/your-org/ai-generic-workspace/issues/new)

Include:
- Description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Node version, etc.)

### 2. **Suggest Features**
Have an idea? [Open a feature request](https://your-git-host.example/your-org/ai-generic-workspace/issues/new)

Include:
- Problem you're trying to solve
- Proposed solution
- Alternative approaches considered
- Example use cases

### 3. **Improve Documentation**
- Fix typos or unclear explanations
- Add examples
- Create tutorials
- Translate documentation

### 4. **Create Agent Templates**
Share your custom agents:
- New domain-specific agents
- Workflow templates
- Example projects

### 5. **Code Contributions**
- Fix bugs
- Implement features
- Improve performance
- Add tests

## Development Setup

```bash
# Fork and clone
git clone https://github.com/YOUR-USERNAME/ai-dev-agent-bla.git
cd ai-dev-agent-bla

# Run setup
./scripts/setup

# Create a branch
git checkout -b feature/your-feature-name
```

## Contribution Guidelines

### Code Style
- Follow existing patterns
- Use clear, descriptive names
- Add comments for complex logic
- Keep functions small and focused

### Commit Messages
Use conventional commits:
```
feat: add new agent for data analysis
fix: correct workflow router logic
docs: update README with examples
refactor: simplify phase transition code
```

### Pull Requests
1. Create a feature branch
2. Make your changes
3. Add/update tests
4. Update documentation
5. Submit PR with clear description

**PR Title Format**:
```
[type]: brief description

Examples:
feat: add Designer agent with Figma integration
fix: resolve Quick Flow routing issue
docs: add workflow examples
```

**PR Description**:
```markdown
## What Changed
[Describe your changes]

## Why
[Explain the reasoning]

## Testing
[How did you test this?]

## Screenshots (if UI changes)
[Add screenshots]

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] No breaking changes (or documented)
```

### Testing
```bash
# Run tests (when available)
npm test

# Test your agent
./scripts/test-agent your-agent-name
```

## Project Structure

```
ai-dev-agent-bla/
├── docs/              # Documentation
├── scripts/           # Utility scripts
├── agent/
│   ├── _phases/       # Phase-organized agents
│   ├── _workflows/    # Workflow templates
│   └── _examples/     # Example projects
└── .claude/           # Claude Code configuration
```

## Agent Development Guidelines

### Creating a New Agent

1. **Choose the Right Phase**
   - Phase 1 (Analysis): Research, requirements
   - Phase 2 (Planning): Design, architecture
   - Phase 3 (Implementation): Code, tests
   - Phase 4 (Delivery): Deploy, document

2. **Agent File Structure**
```markdown
---
name: agent-name
phase: phase-number-name
description: Clear description of agent purpose
color: color-name
version: 1.0.0
mcp_services:
  - service1
  - service2
---

# Agent Name

[Agent documentation following established patterns]
```

3. **Required Sections**
- Core Responsibilities
- Workflow (Input → Process → Output)
- MCP Tool Usage
- Handoff Procedures
- Examples

### Testing Agents

1. Create test scenarios
2. Document expected behavior
3. Test handoffs between agents
4. Verify MCP integration

## Documentation Guidelines

Follow [MARKDOWN_GUIDE.md](MARKDOWN_GUIDE.md):
- Use proper heading hierarchy
- Specify language for code blocks
- Include examples
- Add diagrams where helpful

## Community Guidelines

### Be Respectful
- Assume good intentions
- Be patient with newcomers
- Give constructive feedback
- Focus on ideas, not people

### Be Helpful
- Answer questions
- Review pull requests
- Share knowledge
- Mentor new contributors

### Be Collaborative
- Discuss changes before large PRs
- Accept feedback gracefully
- Credit others' work
- Work together on solutions

## Getting Help

- 💬 [GitHub Discussions](https://github.com/mazaia/ai-dev-agent-bla/discussions)
- 📖 [Documentation](docs/)
- 🐛 [Issues](https://github.com/mazaia/ai-dev-agent-bla/issues)

## Recognition

Contributors are recognized in:
- README.md contributors section
- Release notes
- Annual contributor highlights

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Lane! 🎉
