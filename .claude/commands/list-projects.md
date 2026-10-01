---
description: "List all projects added to the workspace via /add-project"
usage: "/project:list-projects"
---

# List Workspace Projects

List every project that was added to the workspace with `/add-project`.
Projects live in `agent/_projects/` (symlinked by default), and this command
shows each one with its detected skill, description, and git remote.

!./scripts/list-projects

## What it shows
- 📁 Project name (tagged `(linked)` when it's a symlink)
- ⚡ Detected skill (nestjs, nextjs, python, etc.)
- 📖 Description (first README heading or `description.txt`)
- 🔗 Git remote URL

## Related
- `/add-project <source> [name]` — add a project to the workspace

Usage: `/project:list-projects`
