# WSL Deprecation Notice

**Status**: As of Phase 5 (2026-05-06), WSL is no longer required to run the Lane workspace on Windows.

## What changed

The five-phase Node port replaced every `bash` / `jq` / POSIX-`date` / `grep` / `sed` / `find` / `awk` dependency on the workspace's hot path with native Node.js 20+ implementations. Hooks, user-facing scripts, and the JSONL merge driver now run identically on Linux, macOS, and Windows.

## Requirements

- **Node.js 20+** (`node --version` must report v20.x or newer).
- **Git for Windows** (or any git distribution that exposes `git rm` / `git mv` and supports the workspace's custom merge drivers).
- For symlinks under `agent/_projects/`, one of:
  - Developer Mode enabled (Settings → Update & Security → For developers), so unprivileged terminals can create directory junctions, **OR**
  - A privileged terminal at the time `./scripts/add-project` runs (so `mklink` / Node's `fs.symlinkSync('junction')` succeed), **OR**
  - `./scripts/add-project --copy <source>` — copies the project tree instead of linking it (Phase 3 deliverable; see [`docs/specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md`](specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md)).

## What's no longer needed

- WSL / WSL2.
- `bash`, `jq`, `yq`, `python3` for hook execution.
- POSIX-only utilities (`find -mtime`, `grep -oE`, `sed`, `awk`).

## Phase reference

| Phase | Focus | Source |
|-------|-------|--------|
| 1 | `session-stop` hook port | [`docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md`](superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md) |
| 2 | Task summaries | [`docs/specs/spec-2026-05-06-task-summaries.md`](specs/spec-2026-05-06-task-summaries.md) |
| 3 | User-facing scripts (`list-projects`, `fresh-context`, `add-project`, `statusline`) | [`docs/specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md`](specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md) |
| 4 | `git-merge-jsonl-union` driver + `eol=lf` `.gitattributes` | Commits `341644b`, `5a59f4d`, `6a18ab5` (no standalone spec; see [`docs/plans/plan-2026-05-06-node-port-phase-5-complete.md`](plans/plan-2026-05-06-node-port-phase-5-complete.md) base reference) |
| 5 | Remaining 6 hooks + CI matrix expansion + this notice | [`docs/specs/spec-2026-05-06-node-port-phase-5-complete.md`](specs/spec-2026-05-06-node-port-phase-5-complete.md) |

If you previously installed WSL solely to run this workspace's hooks, you can remove it after verifying `npm test` passes natively on Windows.
