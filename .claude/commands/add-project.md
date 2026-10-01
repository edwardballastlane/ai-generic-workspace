---
description: "Add a project from GitHub URL or local path to the workspace"
usage: "/project:add-project <github_url_or_path> [project_name]"
---

# Add Project to Workspace

Add a project to the workspace from GitHub URL or local directory path.
Local directories are **symlinked by default** for live development.

## Options
- `--copy` - Copy files instead of symlinking (local paths only)

## Arguments
- `github_url_or_path` - GitHub URL or local directory path
- `project_name` - Optional name for the project (defaults to repo name)

!./scripts/add-project

## Examples

Add from GitHub:
```bash
./scripts/add-project https://github.com/user/repo
./scripts/add-project git@github.com:user/repo.git my-project
```

Add from local path:
```bash
./scripts/add-project /path/to/local/project                    # Creates symlink
./scripts/add-project --copy /path/to/local/project copied-project
```

## Features
- ✅ Clones GitHub repositories
- 🔗 **Symlinks local directories by default** for live development
- 📁 Optional copying with `--copy` flag
- 📊 Creates project metadata
- 🔍 Auto-detects project types (Node.js, Rust, Python)
- 📋 Lists all current projects

Usage: `/project:add-project <source> [name]`