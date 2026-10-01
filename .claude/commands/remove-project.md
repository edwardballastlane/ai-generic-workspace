---
description: "Remove a project from the workspace by name"
usage: "/project:remove-project <project-name> [--force] [--dry-run]"
---

# Remove Project from Workspace

Remove a project from the workspace. Cleans up all associated artifacts.

## Arguments
- `project-name` - Name of the project to remove (as it appears in `agent/_projects/`)

## Options
- `--force` - Skip confirmation prompt for real directories (cloned repos)
- `--dry-run` - Preview what would be removed without doing it

!./scripts/remove-project

## What gets removed

| Artifact | Behavior |
|----------|----------|
| `agent/_projects/<name>` (symlink) | Unlinked immediately |
| `agent/_projects/<name>` (real dir) | Deleted after typing project name to confirm |
| `.ai-contexts/<name>.yaml` | Deleted |
| `lane.code-workspace` entry | Removed |

## Examples

```bash
# Preview removal
./scripts/remove-project my-app --dry-run

# Remove a symlinked project (no confirmation needed)
./scripts/remove-project my-app

# Remove a cloned repo (skip confirmation prompt)
./scripts/remove-project my-app --force
```

Usage: `/project:remove-project <project-name>`
