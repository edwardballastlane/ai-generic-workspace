# Lane Sync

Cross-machine sync for personal Lane data (lessons, memory, contexts).

## Quick Start

```bash
./scripts/sync init      # Interactive setup wizard
./scripts/sync push      # Push local data
./scripts/sync pull      # Pull and merge remote data
./scripts/sync status    # Check sync state
./scripts/sync reset     # Remove sync config
```

## Backends

| Backend | Path | How it syncs |
|---------|------|-------------|
| **Git repo** | `.ai-sync/` (local clone) | `git commit && git push` |
| **iCloud** | `~/Library/.../LaneSync/` | Automatic (cloud) |
| **Dropbox** | `~/Dropbox/LaneSync/` | Automatic (cloud) |
| **Google Drive** | Auto-detected `/LaneSync/` | Automatic (cloud) |
| **Custom** | Any path you choose | Manual or mount-based |

For the Git backend, create a **private** repo first, then paste the URL during `sync init`.

## What Syncs

| Data | Push | Pull strategy |
|------|------|---------------|
| Lessons (`.ai-memory/lessons/`) | All files | **Merge by ID** — keeps all unique lessons |
| Sessions (`.ai-memory/sessions/`) | All files | **Append-only** — new files only |
| Memory index (`.ai-memory/index.yaml`) | Single file | Last-write-wins |
| Contexts (`.ai-contexts/*.yaml`) | All YAML files | **Pull wins** (regenerable) |
| Claude memory (`~/.claude/.../memory/`) | All files | Last-write-wins |
| Claude settings (`~/.claude/settings.json`) | Single file | Last-write-wins |

## Auto-Sync (Hooks)

When enabled during `sync init`:

- **Auto-push**: After every `capture-lesson`, lessons are pushed in the background (non-blocking)
- **Auto-pull**: On every `start-session`, lessons are pulled before the session begins (10s timeout)

Use `--quick` flag for lessons-only sync (faster). Use `--quiet` to suppress output.

## New Machine Setup

1. Clone/install Lane workspace
2. Run `./scripts/setup`
3. When prompted, choose "Set up Lane Sync"
4. Select the same backend and point to the same sync folder/repo
5. Existing data is auto-detected and pulled

Or run `./scripts/sync init` directly after setup.

## Configuration

Stored in `.ai-config/sync.yaml`:

```yaml
sync:
  backend: "icloud"
  path: "/Users/.../LaneSync"
  remote: ""
  auto_push: true
  auto_pull: true
  last_sync: "2026-03-04T20:00:00Z"
  machine_id: "macbook-work"
```

## Sync Folder Structure

```
LaneSync/
├── lessons/            ← .ai-memory/lessons/
├── sessions/           ← .ai-memory/sessions/
├── memory-index.yaml   ← .ai-memory/index.yaml
├── contexts/           ← .ai-contexts/*.yaml
├── claude-memory/      ← ~/.claude/projects/*/memory/
├── claude-settings.json
└── .sync-meta.yaml     ← tracks which machine last synced
```

## Troubleshooting

**Sync not working?**
- Run `./scripts/sync status` to check configuration
- Verify the sync path exists and is accessible
- For git backend, check `git remote -v` inside `.ai-sync/`

**Lessons not merging?**
- Lessons are merged by ID (`L001`, `L002`, etc.) — duplicates are skipped
- Check that lesson files have proper YAML `- id:` format

**Git push failing?**
- Verify SSH keys or HTTPS credentials for the remote repo
- Run `cd .ai-sync && git push` manually to see the error

**Cloud sync slow?**
- iCloud/Dropbox/Google Drive sync on their own schedule
- The `push` command copies files; the cloud app handles the rest
