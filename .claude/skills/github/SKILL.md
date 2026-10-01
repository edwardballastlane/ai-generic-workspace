---
name: github
description: >
  Query and act on GitHub through the gh CLI (no GitHub MCP server). Use whenever the user asks to list
  repos, branches, commits, PRs, issues, contributors, search code, read a PR diff, discover PR format
  from merged PRs, or create a PR on GitHub. Triggers on "list my repos", "show PRs", "my contributions
  on github", "open a PR", "check merged PRs".
---

# GitHub via gh CLI

Do NOT use `mcp__github__*` tools. Use the wrapper:

```bash
.claude/skills/github/scripts/gh-wrap <command> [args]
```

Run `gh-wrap help` for the command list. Repo defaults to the current git remote; override with
`-R owner/name` or `GH_REPO`. Tune with `LIMIT=` and `STATE=`.

## Common tasks

| Task | Command |
|------|---------|
| Who am I | `gh-wrap me` |
| My repos | `gh-wrap repos` |
| Branches / commits | `gh-wrap -R o/r branches`, `gh-wrap -R o/r commits dev` |
| PRs / one PR / diff | `gh-wrap prs`, `gh-wrap pr 12`, `gh-wrap pr-diff 12` |
| My commits across GitHub | `gh-wrap my-commits [owner/name]` |
| Anything else | `gh-wrap api <endpoint>` |

## Creating a PR

Workspace rules apply (CLAUDE.md #7, #8):

1. Ask user for branch name and base branch first. Never assume.
2. Discover format: `gh-wrap pr-merged` and `gh-wrap pr-templates`. Copy structure of merged PRs.
3. Write body to a temp file, then: `gh-wrap pr-create --base <base> --head <branch> --title "..." --body-file <file>`.
4. No `Co-Authored-By` trailers, no "Generated with Claude Code" footers.

## Notes

- Auth: `gh auth status`. Fix with `gh auth login`.
- Read commands are safe. `pr-create` and `api -X POST/PATCH/DELETE` write to GitHub: confirm with user first.
