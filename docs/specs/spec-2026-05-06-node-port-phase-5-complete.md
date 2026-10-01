# Specification: Node Port — Phase 5: Complete the Port

**Author**: Spec Writer
**Date**: 2026-05-06
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch (planned)**: `feat/node-port-phase-5-complete` (base: `feat/node-port-phase-4-jsonl-merge` tip; auto-rebases to `master` as upstream phases merge)
**Jira**: n/a

---

## 1. Problem Statement

Six hooks in `.claude/settings.json` still invoke bash scripts directly:
- `PreToolUse` → `./scripts/hooks/pre-tool-use.sh`
- `PostToolUse` → `./scripts/hooks/post-tool-use.sh`
- `SessionStart` → `./scripts/hooks/session-start.sh`
- `SubagentStop` → `./scripts/hooks/subagent-stop.sh`
- `PreCompact` → `./scripts/hooks/pre-compact.sh`
- `Notification` → `./scripts/hooks/notify.sh`

These hooks depend on `jq`, `bash`, and POSIX `date`/`cat`. Windows users hit immediate failures; CI cannot exercise hook logic natively on `windows-latest`.

Additionally, `user-prompt-dispatcher.js:100-113` forks `inject-context.sh` via `execFileSync`, which has two active defects:

1. **Empty-stdin bug** (diagnosed this session): `~/.ai-memory/dispatcher-debug.jsonl` shows `rawLen: 0` for every `UserPromptSubmit` invocation. The dispatcher passes `rawStdin` as the `input` option to `execFileSync`, but CC's stdin-piping behavior on Linux delivers the payload to the process-level stdin, not to the spawned child's pipe. The bash hook short-circuits on empty `HOOK_INPUT` (`inject-context.sh:27`), meaning sidecar writes and prompts increment never fire.
2. **Fork overhead**: `execFileSync` for a 408-line bash script adds ≈ 150–400 ms per prompt on top of the `inject-rules` and `context-budget` in-process calls.

The original Phase 1 roadmap (`docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md:19`) listed Phase 2 as "port the other 7 hooks". That work was skipped when the user pivoted to task-summary work (Phase 2 became the task-summaries spec). Phase 5 was originally "WSL deprecation + CLAUDE.md updates + expand CI matrix". This spec folds both into a single closing phase.

`scripts/hooks/session-stop.sh` also remains on disk despite being replaced in `.claude/settings.json` since Phase 1. The deprecation notice at line 11 says "will be removed once cross-OS verification completes". That is now done.

**Who is affected**: All Lane workspace users, especially Windows users who currently have six broken hooks. The sidecar/prompts-counter defect affects dashboard attribution for every Linux/macOS user too.

**Impact of not solving**: Windows parity stays blocked. The sidecar prompts counter never increments (every session shows `prompts: 0` or stays at initial value). Session attribution is silently wrong for multi-terminal users.

---

## 2. Goals

1. Port all six remaining bash hooks to Node.js 20+, eliminating `jq`, `bash`, `date -u`, `cat`, `grep -oE`, `find`, and `sed` from hook execution paths.
2. `inject-context-impl.js` is callable both as a standalone hook (reads stdin) and in-process by `user-prompt-dispatcher.js` (receives `rawStdin` as string arg) — eliminating the `execFileSync` fork and the empty-stdin failure mode.
3. Every ported hook has `tests/hooks/<name>.test.js` with at minimum 3 test cases (happy path, edge case, error path).
4. `scripts/hooks/session-stop.sh` is deleted.
5. `.claude/settings.json` is updated: all six bash hook commands become `node ./scripts/hooks/<name>.js`.
6. `.github/workflows/cross-os-smoke.yml` path triggers and test matrix cover all new hook test files; `npm test` exits 0 on `ubuntu-latest`, `macos-latest`, and `windows-latest`.
7. A `docs/wsl-deprecation.md` document records that WSL is no longer required.
8. `CLAUDE.md` reflects the completed Node port and removes bash-only references.
9. `.ai-session/cc-session-id` and `.ai-session/hook-session-id` are deleted from the repo and ignored; session ID resolution uses payload + transcript path only (per existing dispatcher logic at `user-prompt-dispatcher.js:88-98`).

---

## 3. Non-Goals

- Porting operational one-shot scripts: `scripts/audit-session-attribution.sh`, `scripts/backfill-jira-from-commits.sh`, `scripts/reconcile-session-attribution.sh`, `scripts/backfill-task-from-transcripts.sh`, `scripts/setup-merge-drivers.sh`. These are not on the hot path; stay bash.
- Porting `token-dashboard.sh` (969 lines, embedded HTML/JS). Defer; the TypeScript dashboard at `scripts/session-embedder/dashboard-generator.ts` is the long-term replacement.
- Changing CC's hook protocol or JSON payload schema.
- Modifying `agent/_phases/`, `agent/_core/`, or `.claude/agents/`.
- Adding new hook behaviors beyond what the bash originals do.
- Bash wrapper stubs for the six hooks. Settings.json is the only invoker; updating it to `.js` directly makes stubs unnecessary. (Exception: `scripts/hooks/pre-compact.sh` is already the Phase 3 stub for `scripts/fresh-context` — that stub continues to work unchanged; only the `pre-compact.sh` hook itself is replaced by `pre-compact.js`.)
- Changing hook timeout budgets in `settings.json` (existing: `UserPromptSubmit` 3000 ms, `SessionStart` 10000 ms, `Stop` 5000 ms, `SubagentStop` 5000 ms, `PreCompact` 5000 ms, `Notification` 3000 ms).
- Desktop notification integration for `notify.js` (the commented-out `notify-send` block in `notify.sh:35-44` stays deferred).

---

## 4. Acceptance Criteria

### inject-context.js / inject-context-impl.js

**AC-1** — Given `user-prompt-dispatcher.js` receives a valid CC payload (non-empty `rawStdin`) for a known session, when `runInjectContext(workspaceRoot, rawStdin)` is called, then it invokes `injectContextImpl.run({ rawStdin, workspaceRoot })` in-process (no `execFileSync`), the sidecar at `.ai-session/by-id/<session_id>.json` is created/updated, `prompts` is incremented by 1, `last_active` is updated to current UTC ISO string, and the function returns the context XML string.

**AC-2** — Given `inject-context-impl.js` is invoked with `rawStdin` where `session_id` is absent but `transcript_path` points to a UUID-named `.jsonl`, when `run()` executes, then the UUID is extracted from the filename (replicating `inject-context.sh:39-45`) and used as the effective session ID for all sidecar writes.

**AC-3** — Given `rawStdin` is empty string or not valid JSON, when `inject-context-impl.js` `run()` is called, then the function returns `''` without writing to any sidecar file and without throwing.

**AC-4** — Given `current.yaml` has `claude_session_id: <X>` and the payload `session_id` is `<Y>` (different terminal), when `run()` executes, then `YAML_BOUND` is `false`, the sidecar for `<Y>` does NOT inherit `task` or `jira_ticket` from `current.yaml`, and the context XML is still emitted (project label is non-attributive).

**AC-5** — Given an existing sidecar and `current.yaml` bound to the same session ID (`YAML_BOUND = true`) and `task.original` set, when `run()` executes, then `sidecar.task` equals `task.original` truncated to 120 chars and `sidecar.jira_ticket` reflects the priority chain: TASK_JIRA > PROMPT_JIRA (per `inject-context.sh:126-139`).

**AC-6** — Given a sidecar directory with entries older than 7 days and no `.last-prune` touchfile created today, when `run()` executes, then files older than 7 days are deleted asynchronously (fire-and-forget, `fs.unlink` per entry, non-blocking) and `.last-prune` is touched. Given `.last-prune` was touched today, no prune runs.

### pre-tool-use.js

**AC-7** — Given a Bash tool call whose `command` matches `git push.*--force.*(main|master)` or contains a literal secret-shaped token (patterns from `heuristics.js:17-28` `SECRET_RE`), when `pre-tool-use.js` runs, then it exits with code `2` and prints `BLOCKED: <reason>` to stdout.

**AC-8** — Given a Bash `git push` command that does NOT contain `# pre-push-reviewed`, when `pre-tool-use.js` runs, then it exits `2` and the message directs the user to run `/pre-push`.

**AC-9** — Given a Write tool call writing to a `.env` file whose content matches a secret pattern, when `pre-tool-use.js` runs, then it exits `0` (allowlist per `pre-tool-use.sh:81-84`). Given a Write to a non-exempt path with the same content, exits `2`.

### post-tool-use.js

**AC-10** — Given a Write or Edit tool call with `CLAUDE_TOOL_NAME` and `CLAUDE_TOOL_INPUT` env vars, when `post-tool-use.js` runs, then a line `[$ISO_TIMESTAMP] Write: <file_path>` is appended to `.ai-memory/audit/YYYY-MM-DD.log`; the script exits `0` unconditionally.

**AC-11** — Given a Bash tool call whose command matches any of `(git push|git reset|rm -r|rm -f|mv |chmod |chown )`, when `post-tool-use.js` runs, then the command is logged to the audit file. Given a Bash call not matching, nothing is logged (zero stdout, exits 0).

### session-start.js

**AC-12** — Given a CC `SessionStart` payload with a non-empty `session_id`, when `session-start.js` runs, then `session_id` is written to `.ai-session/cc-session-id` using `atomicWrite` from `scripts/_lib/process.js`, and the script exits `0`.

**AC-13** — Given a `SessionStart` payload with empty or missing `session_id` (or malformed JSON), when `session-start.js` runs, then no file is written, no error thrown, exits `0`.

### subagent-stop.js

**AC-14** — Given a `SubagentStop` payload with `session_id`, `agent_id`, `agent_type`, and `agent_transcript_path`, when `subagent-stop.js` runs, then a JSONL record is atomically appended to `.claude/logs/subagent-events.jsonl` with keys `type`, `ts`, `session_id`, `agent_id`, `agent_type`, `permission_mode`, `transcript_path`, `last_message_preview` (first 200 chars), and exits `0`.

**AC-15** — Given an empty stdin payload, when `subagent-stop.js` runs, then nothing is appended to the events file; exits `0`.

### pre-compact.js

**AC-16** — Given a `PreCompact` payload with `session_id` and `trigger`, when `pre-compact.js` runs, then it calls `require('./fresh-context-impl').run({ sessionId, note: 'pre-compact (<trigger>) — auto-saved before context compaction', workspaceRoot })` in-process, producing a snapshot at `.ai-session/resume/<short>-<ts>.md`; exits `0` with no stdout.

> Note: `pre-compact.js` calls `fresh-context-impl.js` in-process. **CONFIRMED**: `scripts/fresh-context.js` (Phase 3 output) does NOT currently export `run()` — it is a standalone script with `function runLatest()` only (`fresh-context.js:317`). Phase 5 implementer must extract the main logic into `scripts/fresh-context-impl.js` exporting `run()`, and refactor `fresh-context.js` to a thin wrapper that calls the impl. This is one extra commit early in the Phase 5 sequence. If the refactor is too risky, fall back to `spawnSync('node', ['./scripts/fresh-context.js', ...])` from `pre-compact.js` — captured as risk R-1.

### notify.js

**AC-17** — Given a `Notification` payload with `session_id`, `level`, and `message`, when `notify.js` runs, then a JSONL record `{ type: "notification", ts, session_id, level, message, source: "claude-code" }` is appended to `.claude/logs/notifications.jsonl`; exits `0`.

**AC-18** — Given empty stdin or malformed JSON, when `notify.js` runs, then nothing is written; exits `0`.

### Dispatcher refactor

**AC-19** — Given `user-prompt-dispatcher.js` imports `inject-context-impl.js` at startup, when `runInjectContext` is called, then it invokes `injectContextImpl.run(...)` synchronously in the same process (no `execFileSync`, no subprocess). The `execFileSync` import at `user-prompt-dispatcher.js:29` is removed.

**AC-20** — Given `readStdin()` in `user-prompt-dispatcher.js` is called and `fs.readFileSync(0, 'utf8')` returns a non-empty string, when the dispatcher runs, then `rawStdin` equals that string. Given `readFileSync(0)` returns empty string (CC Linux behavior), then the dispatcher falls back to reading `process.stdin` via a synchronous drain loop (or `fs.readFileSync('/dev/stdin', 'utf8')` as secondary), and `rawStdin` equals the actual payload. If both return empty, `rawStdin = ''` and `inject-context-impl` short-circuits per AC-3.

### Cross-cutting

**AC-21** — Given Phase 5 lands, when `.claude/settings.json` is read, then all six hook commands that previously referenced `.sh` files now reference `node ./scripts/hooks/<name>.js`: `pre-tool-use.js`, `post-tool-use.js`, `session-start.js`, `subagent-stop.js`, `pre-compact.js`, `notify.js`. Timeout values are unchanged.

**AC-22** — Given `scripts/hooks/session-stop.sh` is deleted and `.claude/settings.json` Stop hook references `session-stop.js`, when `npm test` runs, then `tests/hooks/session-stop.test.js` still passes (no path to the `.sh` file is exercised).

**AC-23** — Given `.github/workflows/cross-os-smoke.yml`, when Phase 5 PR is opened, then the `paths` trigger includes `scripts/hooks/inject-context*.js`, `scripts/hooks/pre-tool-use.js`, `scripts/hooks/post-tool-use.js`, `scripts/hooks/session-start.js`, `scripts/hooks/subagent-stop.js`, `scripts/hooks/pre-compact.js`, `scripts/hooks/notify.js`, and `tests/hooks/**`; the matrix runs on `ubuntu-latest`, `macos-latest`, `windows-latest`; all three legs must be green before merge.

**AC-24** — Given `docs/wsl-deprecation.md` is present after Phase 5, when a Windows user reads it, then it states: (a) WSL is no longer required; (b) all hooks run via `node` natively; (c) `agent/_projects/` symlinks use junctions (Phase 3); (d) minimum Node version is 20.

**AC-25** — Given `CLAUDE.md` is read after Phase 5, when the hooks/Node port section is found, then it no longer references any `.sh` hook file, lists the CommonJS + `node:test` + `node:` prefix conventions, and includes a "Node port phases complete" marker with references to Phase 1–5 spec files.

**AC-26** — Given `.ai-session/cc-session-id` and `.ai-session/hook-session-id` exist in the repo at Phase 5 start, when Phase 5 implementation commits land, then both files are deleted and `.gitignore` gains entries for `.ai-session/cc-session-id` and `.ai-session/hook-session-id` (these files were the original multi-terminal cross-attribution vector; Node hooks no longer write them — except `session-start.js` which writes `cc-session-id` for legacy consumers; add a TODO comment if any consumer remains).

---

## 5. Technical Design

### 5.1 Architecture

Two new files are the core deliverables:

- `scripts/hooks/inject-context-impl.js` — the port of `inject-context.sh`. Exports `run({ rawStdin, workspaceRoot })`. Replicates all logic in `inject-context.sh:23-408`: stdin parse, session-ID recovery from transcript path, sidecar create/update (via `atomicWrite`), YAML_BOUND check, Jira priority chain, project detection (4 sources), `<no-active-session>` XML emit, `<project-context>` XML emit, and async sidecar prune.
- `scripts/hooks/inject-context.js` — thin entry-point wrapper. Reads fd 0 via `fs.readFileSync(0, 'utf8')`, calls `injectContextImpl.run(...)`, prints result, exits 0.

The other five ports are self-contained (no separate `*-impl.js` needed — each is ≤ 100 lines):
- `scripts/hooks/pre-tool-use.js` — port of `pre-tool-use.sh:1-93`. Reads stdin (CC delivers PreToolUse data via stdin per `pre-tool-use.sh:13`).
- `scripts/hooks/post-tool-use.js` — port of `post-tool-use.sh:1-47`. Reads env `CLAUDE_TOOL_NAME`, `CLAUDE_TOOL_INPUT`. Parses JSON-in-env-var via `JSON.parse` (replaces `grep -o '"file_path"...' | sed` at `post-tool-use.sh:34-36`).
- `scripts/hooks/session-start.js` — port of `session-start.sh:1-27`. Reads stdin JSON, extracts `session_id`, writes `cc-session-id` via `atomicWrite`.
- `scripts/hooks/subagent-stop.js` — port of `subagent-stop.sh:1-40`. Reads stdin JSON, appends JSONL record to `.claude/logs/subagent-events.jsonl` via `fs.appendFileSync`.
- `scripts/hooks/pre-compact.js` — port of `pre-compact.sh:1-38`. Reads `session_id` + `trigger` from stdin JSON, calls `fresh-context-impl` in-process.
- `scripts/hooks/notify.js` — port of `notify.sh:1-45`. Reads stdin JSON, appends JSONL record to `.claude/logs/notifications.jsonl`.

### 5.2 Key Design Decisions

**OQ-1 resolved: one PR, one commit per hook.** Single branch `feat/node-port-phase-5-complete`, commits ordered: `fresh-context refactor (extract impl)` → `inject-context-impl.js` → `dispatcher refactor` → `pre-tool-use.js` → `post-tool-use.js` → `session-start.js` → `subagent-stop.js` → `pre-compact.js` → `notify.js` → `settings.json update` → `session-stop.sh + 6 .sh delete` → `CI expand` → `docs + CLAUDE.md`.

**OQ-2 resolved: delete bash files, no stubs.** Settings.json is the sole invoker. Update settings.json to point at `.js`; delete the six `.sh` files in the same PR.

**OQ-3 resolved: BOTH.** `inject-context-impl.js` exports `run()`; `inject-context.js` is the stdin-reading entry point; dispatcher imports the impl.

**OQ-4 resolved: integration test with `< /dev/null`.** `tests/hooks/inject-context.test.js` includes a case that spawns the dispatcher with `/dev/stdin` redirected from `/dev/null` and asserts that no sidecar file was created or modified.

**OQ-5 resolved: DELETE `cc-session-id` and `hook-session-id`.** `session-start.js` can still write `cc-session-id` for now (it's the canonical place), but inject-context-impl must never READ it (consistent with dispatcher's existing `resolveSessionId` at `user-prompt-dispatcher.js:88-98`).

### 5.3 Reused Utilities (`scripts/_lib/`)

| Utility | Usage in Phase 5 |
|---|---|
| `process.js` → `atomicWrite` | sidecar writes in `inject-context-impl.js` |
| `heuristics.js` → `looksLikeSecret`, `SECRET_RE` | `pre-tool-use.js` secret detection |
| `heuristics.js` → `extractJiraTicket` | Jira chain in `inject-context-impl.js` |

All five `_lib` modules are CommonJS (`'use strict'`, `module.exports`). Phase 5 code must follow the same convention.

### 5.4 stdin Reading Pattern

The dispatcher passes `rawStdin` directly to `injectContextImpl.run()` — no stdin read inside the impl when called in-process. The standalone wrapper `inject-context.js` uses:

```js
'use strict';
const fs = require('node:fs');
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* fd 0 unreadable */ }
if (!raw) {
  // Fallback: synchronous drain of process.stdin (covers alternate piping)
  try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch { /* not available on Windows */ }
}
require('./inject-context-impl').run({ rawStdin: raw, workspaceRoot: require('./_lib/workspace-root').findWorkspaceRoot() });
```

On Windows `readFileSync('/dev/stdin')` throws; the `catch` swallows it gracefully, and `rawStdin = ''` causes the impl to no-op per AC-3.

### 5.5 inject-context-impl.js — sidecar write

The jq-based sidecar update at `inject-context.sh:160-168` and create at `inject-context.sh:176-179` must be replaced with pure Node JSON manipulation:

```js
const data = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
data.prompts = (data.prompts || 0) + 1;
data.last_active = now;
data.cwd = userCwd;
if (yamlBound && taskTitle) data.task = taskTitle;
if (trustedJira) data.jira_ticket = trustedJira;
else if (clearStaleJira) data.jira_ticket = '';
await atomicWrite(sidecar, JSON.stringify(data, null, 2));
```

The custom-title write to CC's JSONL (`inject-context.sh:187-198`) appends a JSON object via `fs.appendFileSync` using `JSON.stringify`.

### 5.6 pre-tool-use.js — secret pattern extension

`pre-tool-use.sh:19-28` includes secret patterns BEYOND `heuristics.js`'s current `SECRET_RE` — raw `KEY=`, `SECRET=`, `TOKEN=`, `PASSWORD=` assignments without quote-shape constraints. Phase 5 must extend `heuristics.js` to expose these or add a `looksLikeShellSecret()` helper. Prefer extending `heuristics.js` — it is the canonical secret-detection location and is already used by `session-stop.js`, `reconcile-session-events.js`, and `inject-context-impl.js` (new).

### 5.7 Settings.json target state

```json
"PreToolUse": [{"matcher": "Bash|Write|Edit", "hooks": [{"type": "command", "command": "node ./scripts/hooks/pre-tool-use.js"}]}],
"PostToolUse": [{"matcher": "Bash|Write|Edit", "hooks": [{"type": "command", "command": "node ./scripts/hooks/post-tool-use.js"}]}],
"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "node ./scripts/hooks/user-prompt-dispatcher.js", "timeout": 3000}]}],
"SessionStart": [{"hooks": [{"type": "command", "command": "node ./scripts/hooks/session-start.js", "timeout": 10000}]}],
"Stop": [{"hooks": [{"type": "command", "command": "node ./scripts/hooks/session-stop.js", "timeout": 5000}]}],
"SubagentStop": [{"hooks": [{"type": "command", "command": "node ./scripts/hooks/subagent-stop.js", "timeout": 5000}]}],
"PreCompact": [{"hooks": [{"type": "command", "command": "node ./scripts/hooks/pre-compact.js", "timeout": 5000}]}],
"Notification": [{"hooks": [{"type": "command", "command": "node ./scripts/hooks/notify.js", "timeout": 3000}]}]
```

### 5.8 CI expansion (`.github/workflows/cross-os-smoke.yml`)

Add to `paths`:
```yaml
- 'scripts/hooks/inject-context*.js'
- 'scripts/hooks/pre-tool-use.js'
- 'scripts/hooks/post-tool-use.js'
- 'scripts/hooks/session-start.js'
- 'scripts/hooks/subagent-stop.js'
- 'scripts/hooks/pre-compact.js'
- 'scripts/hooks/notify.js'
- 'tests/hooks/**'
```

`npm test` already runs `node:test` glob over `tests/**/*.test.js` — no changes to the test runner invocation needed, only the path trigger.

---

## 6. Cost & Performance

Hook latency budgets are fixed in `settings.json`. Phase 5 must not increase measured p95 beyond current baselines in `.ai-memory/hook-timings.jsonl`.

| Hook | Timeout | Expected p95 (after port) | Basis |
|---|---|---|---|
| `UserPromptSubmit` (dispatcher) | 3000 ms | < 200 ms | `inject-context` in-process eliminates ≈ 150-400 ms `execFileSync` round-trip |
| `SessionStart` | 10000 ms | < 50 ms | Simple JSON parse + one atomic file write |
| `Stop` | 5000 ms | unchanged — `session-stop.js` already Node | — |
| `SubagentStop` | 5000 ms | < 30 ms | JSON parse + `appendFileSync` |
| `PreCompact` | 5000 ms | < 300 ms | In-process `fresh-context-impl` call |
| `Notification` | 3000 ms | < 20 ms | JSON parse + `appendFileSync` |
| `PreToolUse` | none set | < 50 ms | JSON parse + regex match |
| `PostToolUse` | none set | < 20 ms | Env read + regex + `appendFileSync` |

The `dispatcher-debug.jsonl` timing instrumentation (added during diagnostic) should be extended to log `inject_context_ms` before and after the in-process refactor so the latency gain is measurable.

---

## 7. Implementation Notes

- **Start with `fresh-context-impl.js` extraction** — `pre-compact.js` depends on it. Refactor `scripts/fresh-context.js` to `scripts/fresh-context-impl.js` (exports `run()`) plus `scripts/fresh-context.js` (thin wrapper reading argv/stdin, calls impl). Existing Phase 3 tests must still pass.
- `inject-context-impl.js` is the largest port (408 lines → ~250 lines Node). After the fresh-context refactor, port this next; it unblocks the dispatcher refactor.
- YAML parsing in `inject-context-impl.js` uses the same inline `parseSimpleYaml` helper already established in Phase 3 specs — do not import `js-yaml`.
- The CWD-based project detection loop (`inject-context.sh:252-278`) maps directly to `fs.readdirSync(projectsDir)` + filter by path segment; no glob needed.
- The meta-command detection (`inject-context.sh:348-361`) uses `grep -qE` on the prompt text — port to a single `META_CMD_RE.test(userPrompt)` with the same pattern list.
- `post-tool-use.sh:34-36` uses `grep -o '"file_path"...' | sed` to extract JSON fields from an env-var string. Replace with `JSON.parse(toolInput).file_path` — the env var is valid JSON.
- All new files: `'use strict';` header, CommonJS `module.exports`, `node:` prefix for builtins.
- Tests use `node:test` + `node:assert`, tempdir fixtures via `node:os` `tmpdir()` + `node:fs/promises` `mkdtemp`. Pattern established in `tests/hooks/session-stop.test.js`.

---

## 8. Risks & Open Questions

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R-1 | `fresh-context.js` (Phase 3) does not export `run()` | **Confirmed** | Extract `run()` into `fresh-context-impl.js`, refactor `fresh-context.js` to wrapper. First commit in Phase 5 sequence. |
| R-2 | `pre-tool-use.sh` actually receives tool data via stdin, not env vars | Confirmed (line 13) | `pre-tool-use.js` reads `process.stdin` synchronously, same as other hooks |
| R-3 | `post-tool-use.sh` env var `CLAUDE_TOOL_INPUT` is not valid JSON on some CC versions | Low | Wrap `JSON.parse` in try/catch; fall back to regex extraction matching the bash original |
| R-4 | `inject-context-impl.js` cc-JSONL `custom-title` append on Windows uses `userCwd.replace(/\//g, '-')` slug; Windows path separators differ | Medium | Use `userCwd.replace(/[\\/]/g, '-')` for cross-OS slug; test on `windows-latest` |
| R-5 | `readFileSync(0, 'utf8')` on Windows returns empty for hooks invoked by CC | Medium | Confirmed pattern from dispatcher session; the `/dev/stdin` fallback doesn't help on Windows. Add third fallback: accumulate `process.stdin` data synchronously via `fs.readSync(0, ...)` loop if fd 0 + `/dev/null` both fail. For `inject-context.js`, empty stdin is handled by AC-3 no-op. |
| R-6 | Sidecar prune (`find … -mtime +7 -delete`) replaced with Node `fs.readdirSync` + `fs.statSync` mtime check — different mtime semantics on Windows (atime vs mtime) | Low | Use `Date.now() - stat.mtimeMs > 7 * 86400_000`; mtimeMs is reliable on all platforms |

---

## 9. File Map

**New files:**

| File | Description |
|---|---|
| `scripts/fresh-context-impl.js` | Extracted impl from Phase 3's `fresh-context.js`; exports `run()` |
| `scripts/hooks/inject-context-impl.js` | Port of `inject-context.sh`; exports `run({ rawStdin, workspaceRoot })` |
| `scripts/hooks/inject-context.js` | Standalone wrapper: reads fd 0, calls impl, exits 0 |
| `scripts/hooks/pre-tool-use.js` | Port of `pre-tool-use.sh`; reads stdin, exits 0 or 2 |
| `scripts/hooks/post-tool-use.js` | Port of `post-tool-use.sh`; reads env vars, appends audit log |
| `scripts/hooks/session-start.js` | Port of `session-start.sh`; writes `cc-session-id` via atomicWrite |
| `scripts/hooks/subagent-stop.js` | Port of `subagent-stop.sh`; appends to `subagent-events.jsonl` |
| `scripts/hooks/pre-compact.js` | Port of `pre-compact.sh`; calls `fresh-context-impl` in-process |
| `scripts/hooks/notify.js` | Port of `notify.sh`; appends to `notifications.jsonl` |
| `tests/hooks/inject-context.test.js` | ≥ 3 cases: sidecar create, empty-stdin no-op, YAML_BOUND guard |
| `tests/hooks/pre-tool-use.test.js` | ≥ 3 cases: force-push block, pre-push-reviewed allow, secret block |
| `tests/hooks/post-tool-use.test.js` | ≥ 3 cases: Write log, Bash destructive log, benign Bash no-log |
| `tests/hooks/session-start.test.js` | ≥ 3 cases: valid session_id write, empty id no-op, malformed JSON |
| `tests/hooks/subagent-stop.test.js` | ≥ 3 cases: full payload append, empty stdin no-op, dir creation |
| `tests/hooks/pre-compact.test.js` | ≥ 3 cases: fresh-context called, session_id passed, empty stdin |
| `tests/hooks/notify.test.js` | ≥ 3 cases: full payload append, empty stdin no-op, level field |
| `docs/wsl-deprecation.md` | WSL no longer required note |

**Modified files:**

| File | Change |
|---|---|
| `scripts/fresh-context.js` | Refactor to thin wrapper calling `fresh-context-impl.js` |
| `scripts/_lib/heuristics.js` | Add shell-secret patterns (`KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=` assignments) used by `pre-tool-use.js` |
| `scripts/hooks/user-prompt-dispatcher.js` | Remove `execFileSync` import; add `injectContextImpl` import; replace `runInjectContext` subprocess call with in-process call; improve stdin fallback in `readStdin()` |
| `.claude/settings.json` | All six `.sh` hook commands → `node ./scripts/hooks/<name>.js` |
| `.github/workflows/cross-os-smoke.yml` | Expand `paths` trigger to include new hook files |
| `CLAUDE.md` | Remove `.sh` hook references; document Node port completion; add Phase 5 spec citation |
| `.gitignore` | Add `.ai-session/cc-session-id` and `.ai-session/hook-session-id` |

**Deleted files:**

| File | Reason |
|---|---|
| `scripts/hooks/inject-context.sh` | Replaced by `inject-context.js` |
| `scripts/hooks/pre-tool-use.sh` | Replaced by `pre-tool-use.js` |
| `scripts/hooks/post-tool-use.sh` | Replaced by `post-tool-use.js` |
| `scripts/hooks/session-start.sh` | Replaced by `session-start.js` |
| `scripts/hooks/subagent-stop.sh` | Replaced by `subagent-stop.js` |
| `scripts/hooks/pre-compact.sh` | Replaced by `pre-compact.js` |
| `scripts/hooks/notify.sh` | Replaced by `notify.js` |
| `scripts/hooks/session-stop.sh` | Deprecated since Phase 1; Node version active since Phase 1 merge |
| `.ai-session/cc-session-id` | Multi-terminal cross-attribution vector; gitignored going forward |
| `.ai-session/hook-session-id` | Same as above |

---

## Grounding Citations

- Phase 1 roadmap (phases 2–5): `docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md:17-22`
- Empty-stdin dispatcher bug (rawLen: 0): `scripts/hooks/user-prompt-dispatcher.js:54` (`readFileSync('/dev/stdin')`)
- Dispatcher subprocess call being replaced: `scripts/hooks/user-prompt-dispatcher.js:100-113`
- inject-context.sh sidecar create/update logic: `scripts/hooks/inject-context.sh:151-206`
- inject-context.sh Jira priority chain: `scripts/hooks/inject-context.sh:119-148`
- inject-context.sh YAML_BOUND guard: `scripts/hooks/inject-context.sh:96-103`
- inject-context.sh meta-command skip: `scripts/hooks/inject-context.sh:348-378`
- inject-context.sh project detection (4 sources): `scripts/hooks/inject-context.sh:218-316`
- pre-tool-use.sh secret patterns: `scripts/hooks/pre-tool-use.sh:19-28`
- pre-tool-use.sh stdin read: `scripts/hooks/pre-tool-use.sh:13`
- post-tool-use.sh env var read: `scripts/hooks/post-tool-use.sh:15-16`
- post-tool-use.sh jq-free sed extraction (to replace): `scripts/hooks/post-tool-use.sh:34-36`
- session-stop.sh deprecation notice: `scripts/hooks/session-stop.sh:11-14`
- Current settings.json hook wiring: `.claude/settings.json:7-94`
- CI path triggers: `.github/workflows/cross-os-smoke.yml:5-9`
- Phase 3 spec AC layout (22-AC format reference): `docs/specs/spec-2026-05-06-node-port-phase-3-user-facing-scripts.md:62-120`
- `heuristics.js` secret patterns (canonical): `scripts/_lib/heuristics.js:17-28`
- `atomicWrite` utility: `scripts/_lib/process.js:14-18`
- `fresh-context.js` lacks `run()` export (R-1 confirmation): `scripts/fresh-context.js:317` (`function runLatest()` only)
