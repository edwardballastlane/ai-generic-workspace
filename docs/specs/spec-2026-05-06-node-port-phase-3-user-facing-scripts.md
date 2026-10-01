# Specification: Node Port — Phase 3: User-Facing Scripts

**Author**: Spec Writer
**Date**: 2026-05-06
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch (planned)**: `feat/node-port-phase-3-user-facing-scripts` (base: `master`, after Phase 2 merges)
**Jira**: n/a

---

## 1. Problem Statement

Four user-facing bash scripts (`fresh-context`, `list-projects`, `add-project`, `statusline`) each invoke external tools (`jq`, `yq`, `python3`, `awk`) and use bash-only idioms (`ln -s`, `ls -t | tail | xargs`, heredocs, `eval echo`) that make them non-portable to Windows and fragile on systems without those utilities pre-installed.

`statusline` is additionally a performance hazard: it forks `jq` twice per invocation (stdin parse + sidecar update) plus one `awk` call per token-format segment, all on the critical path of every Claude Code keypress.

**Who is affected**: Every Lane workspace user. Windows users see broken symlink creation and missing `jq`/`yq`. macOS/Linux users see unnecessary fork-exec overhead on the statusline. CI cannot test these scripts without a full bash + GNU coreutils environment.

**Impact of not solving**: Windows support is blocked (Phase 1 plan `docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md:22` explicitly gates it on this phase). `statusline` cold-start latency degrades as transcript files grow. `add-project` is untestable in the cross-OS CI matrix from Phase 1.

---

## 2. Goals

1. Port all four scripts to Node.js 20+, eliminating `jq`, `yq`, `python3`, and `awk` from their execution paths.
2. Each ported script produces identical stdout to its bash counterpart on Linux and macOS for all documented modes and flags.
3. `statusline.js` cold-start to first stdout byte is under 200 ms on a warm Node 20+ runtime (excluding cold JIT, measured from process start to `process.stdout.write`).
4. `add-project.js` uses directory junctions on Windows and regular symlinks on Linux/macOS, transparently, without requiring elevated privileges.
5. `fresh-context.js` writes `latest.md` as a plain file copy rather than a symlink — cross-platform, no admin, acceptable trade-off on atomic update.
6. Each ported script has an integration test in `tests/scripts/<name>.test.js` that runs the entry point via `spawnSync` with synthetic args/stdin against a tempdir fixture.
7. The four bash originals are replaced with **wrapper stubs** that `exec node ./scripts/<name>.js "$@"` to preserve all existing callers (notably `scripts/hooks/pre-compact.sh:16` invokes `scripts/fresh-context` directly). Callers see no behavior change. A separate cleanup pass (out of scope) can update callers to invoke the `.js` directly and then drop the stubs.
8. `.claude/settings.json` `statusLine.command` is updated to `"node ./scripts/statusline.js"`.
9. All new code follows Phase 1 conventions (`docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md:54-60`): CommonJS, `async/await`, `node:test`, no global state, `try/catch`-swallow at every I/O boundary.

---

## 3. Non-Goals

- Porting other bash hooks (`pre-tool-use.sh`, `post-tool-use.sh`, `session-start.sh`, `subagent-stop.sh`, `pre-compact.sh`, `notify.sh`) — deferred.
- Porting `git-merge-jsonl-union.sh` or other `.sh` files in `scripts/` — Phase 4.
- Modifying `agent/_phases/`, `.claude/agents/`, or any hook not listed above.
- Changing the schema of `.ai-session/current.yaml` or `.ai-contexts/*.yaml` — back-compat required; Phase 3 only reads these files.
- Symlink permission elevation on Windows — junctions sidestep UAC for directory links; no admin prompts.
- Porting `scripts/perm` — not in scope per Phase 1 plan.
- Redesigning the visual output format of any script — output parity is required.

---

## 4. User Stories

**US-1 — statusline renders on Windows.** Running Claude Code on Windows with the Node port wired in `.claude/settings.json` shows the full statusline without requiring `jq` or bash.

**US-2 — add-project links a local dir on Windows.** `node ./scripts/add-project.js ~/code/my-app` on Windows creates a junction at `agent/_projects/my-app`, logs `linked (junction)`, and writes `.ai-contexts/my-app.yaml`.

**US-3 — fresh-context produces a readable snapshot.** `node ./scripts/fresh-context.js` saves `<shortid>-<ts>.md` and writes identical content to `latest.md` (plain copy). `--latest` prints the content.

**US-4 — list-projects shows all projects quickly.** With 10+ projects, `node ./scripts/list-projects.js` completes under 3 s because `git remote get-url` calls are parallelized via `Promise.all`.

---

## 5. Acceptance Criteria

### fresh-context.js

**AC-1** — Given `node ./scripts/fresh-context.js` with a valid sidecar at `.ai-session/by-id/<sid>.json`, when run, then `<shortid>-<ts>.md` is written to `.ai-session/resume/` and the same content is written to `latest.md` as a plain file; `fs.lstatSync('latest.md').isSymbolicLink()` returns `false`.

**AC-2** — Given `node ./scripts/fresh-context.js --latest` and a pre-existing `latest.md`, when run, then file contents are printed to stdout and exits 0. Given no `latest.md`, prints an error to stderr and exits 1.

**AC-3** — Given `node ./scripts/fresh-context.js --print`, when run, then markdown is written to stdout only; no file is created in `.ai-session/resume/`.

**AC-4** — Given more than 20 snapshot files in `.ai-session/resume/` (excluding `latest.md`), when `fresh-context.js` saves a new snapshot, then the oldest files beyond 20 are deleted (by mtime descending).

### list-projects.js

**AC-5** — Given `agent/_projects/` with N ≥ 2 projects each having `.git/`, when `node ./scripts/list-projects.js` runs, then all `git remote get-url origin` calls are issued concurrently via `Promise.all` and the process exits within 3 s for N ≤ 20.

**AC-6** — Given a project entry that is a symlink (or junction on Windows), when `list-projects.js` enumerates it, then `fs.lstatSync(entry).isSymbolicLink()` correctly identifies it and the entry is listed (no silent skip).

**AC-7** — Given no `.ai-config/settings.yaml` present, when `list-projects.js` runs, then it prints the "Setup Required" message and exits 1 without throwing.

### add-project.js

**AC-8** — Given a local directory path on Linux/macOS, when `node ./scripts/add-project.js /path/to/myapp`, then `agent/_projects/myapp` is created as a directory symlink and `fs.lstatSync(dest).isSymbolicLink()` returns `true`.

**AC-9** — Given a local directory path on Windows (`process.platform === 'win32'`), when `node ./scripts/add-project.js C:\path\to\myapp`, then `agent/_projects/myapp` is created via `fs.symlinkSync(target, dest, 'junction')`, stdout contains `linked (junction)`, and the path is navigable.

**AC-10** — Given a Git URL (GitHub/Bitbucket/GitLab/Azure), when `node ./scripts/add-project.js <url>`, then `git clone` is invoked via `execFileSync('git', ['clone', url, destDir])` with no shell, `.ai-contexts/<name>.yaml` is written with detected `git.platform`, and `lane.code-workspace` is updated using `path.relative` + `JSON.parse/stringify` without invoking `python3`.

**AC-11** — Given a bare name with no URL and no existing local path, when `node ./scripts/add-project.js my-new-app`, then `agent/_projects/my-new-app/` is created with `docs/`, `src/`, and `README.md`; `git init` runs via `execFileSync`; `.ai-contexts/my-new-app.yaml` is written.

### statusline.js

**AC-12** — Given a valid CC statusline JSON payload on stdin and a pre-existing transcript JSONL, when `node ./scripts/statusline.js` runs, then the colored output line appears on stdout in under 200 ms from process start (measured as elapsed ms from first line of `main()` to `process.stdout.write`; testable with `DEBUG_STATUSLINE=1` env var that logs the delta to stderr).

**AC-13** — Given a transcript where the last `message.usage` block shows tokens summing to 75% of the autocompact threshold, when `statusline.js` renders, then the CTX% segment shows `75%` in warning color (`\x1b[1;38;2;245;158;11m`). Given ≥ 85%, shows in critical color and prepends `COMPACT NOW`.

**AC-14** — Given a sidecar where `cost_usd` differs from incoming `cost.total_cost_usd`, when `statusline.js` runs, then the sidecar is updated atomically via `atomicWrite` from `scripts/_lib/process.js` with field semantics matching `scripts/statusline:239-251` (`input_tokens` = raw only, `cache_creation_tokens` = cache-write component).

**AC-15** — Given `process.stdout.isTTY === false` or `NO_COLOR=1` set, when any of the four scripts runs, then no ANSI escape sequences appear in stdout.

### Cross-cutting

**AC-16** — Given any of the four bash wrapper stubs, when invoked with args A, then it execs `node ./scripts/<name>.js "$@"` and the parent shell observes the exact same stdout, stderr, and exit code as the `.js` directly. Specifically: `scripts/hooks/pre-compact.sh` continues to produce a snapshot at `.ai-session/resume/<sid>-<ts>.md` after the port, with no edits to `pre-compact.sh`.

**AC-17** — Given the Phase 3 changes landed, when `.claude/settings.json` is read, then `statusLine.command` equals `"node ./scripts/statusline.js"`.

### Cross-OS hardening (added after gap audit)

**AC-18** — Given Phase 3 is merged, when a Windows user invokes `scripts\fresh-context` (or `list-projects` / `add-project` / `statusline`) from `cmd.exe` or PowerShell, then a `scripts\<name>.cmd` sibling exists and execs the `.js` version. Each `.cmd` file is 2 lines: `@echo off` + `node "%~dp0%~n0.js" %*`. Both bash callers (Git Bash, MSYS2, WSL) and native Windows shells (cmd, PowerShell) work without invoking `node` explicitly.

**AC-19** — Given any of the four new `.js` files, when checked via `fs.statSync(file).mode & 0o111`, then the executable bit is set on at least owner+group (mode `0o755`). The implementation calls `fs.chmodSync(file, 0o755)` after creation in the implementer's commit, OR adds `chmod +x` to a post-test step. Verifies via a unit test that asserts mode parity with the bash original.

**AC-20** — Given `statusline.js` or `list-projects.js` runs on Windows where `process.platform === 'win32'` and `process.env.WT_SESSION` is unset (legacy `cmd.exe` / PowerShell ISE), when ANSI escapes are emitted, then 24-bit truecolor (`\x1b[38;2;R;G;Bm`) is replaced with 16-color fallbacks (`\x1b[31m`-`\x1b[36m`) so the line renders as colored text rather than literal escape sequences. On Windows Terminal (`WT_SESSION` set) and on macOS/Linux, full 24-bit colors are used. Single helper `pickColors()` selects the palette once at startup.

**AC-21** — Given `add-project.js` creates a junction on Windows for a directory target, when `list-projects.js` reads the projects directory, then `fs.lstatSync(<entry>).isSymbolicLink()` returns `true` for that junction (Node 20+ behavior). Verified by a unit test that creates a junction in a tempdir on Windows runners (`process.platform === 'win32'` gate) and asserts `isSymbolicLink() === true`. On Linux/macOS the test creates a regular symlink and asserts the same.

**AC-22** — Given Phase 3 is opened as a PR, when `.github/workflows/cross-os-smoke.yml` runs, then `npm test` exits 0 on `ubuntu-latest`, `macos-latest`, AND `windows-latest`. The PR is mergeable only when all three matrix legs are green. Specifically: every new `tests/scripts/*.test.js` file runs on all three OSes; any test that is unavoidably OS-specific (e.g., junction creation) gates with `t.skip(...)` on the wrong platform rather than failing.

---

## 6. Technical Design

### 6.1 API Contracts

#### `scripts/_lib/transcript.js` — additive change

Extend `readTranscript` return type to include `lastUsage` (backward-compatible; existing callers destructure only `{ tokens, model, userPrompts }`):

```js
// {
//   tokens: { input, output, cacheRead, cacheCreation },
//   model: string,
//   userPrompts: string[],
//   lastUsage: { input_tokens, cache_creation_input_tokens,
//                cache_read_input_tokens, output_tokens } | null
// }
```

Track `let lastUsage = null` inside the existing readline loop at `transcript.js:46`; set it to `row.message.usage` on every usage-bearing line (last write wins). Return it in the result object at `transcript.js:71`. This replaces `statusline:169-171`'s `tail -n 100 | jq ... | tail -1` with zero additional file I/O.

#### Inline YAML helper — used in fresh-context.js and list-projects.js

```js
// Inline — do NOT extract to _lib/yaml-mini.js (two usages, no third consumer yet)
function parseSimpleYaml(text, keys) {
  const result = {};
  for (const key of keys) {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    result[key] = m ? m[1].replace(/^["']|["']$/g, '').trim() : '-';
  }
  return result;
}
```

In `fresh-context.js`: extracts `['workflow', 'phase', 'phase_name', 'agent', 'refined', 'original', 'status']` from `current.yaml` (replicating `fresh-context:117-122`). `refined // original` fallback: `task = result.refined !== '-' ? result.refined : result.original`.

In `list-projects.js`: extracts `['platform']` from `.ai-config/settings.yaml` and `['language']` from `.ai-contexts/<name>.yaml`.

#### `scripts/add-project.js` — key logic

Platform-transparent symlink (replaces `ln -s` at `add-project:295`):
```js
const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(resolvedPath, destPath, symlinkType);
if (symlinkType === 'junction') process.stdout.write('linked (junction)\n');
```

`~` expansion (replaces `eval echo` at `add-project:281`):
```js
const expandHome = s =>
  s.startsWith('~/') || s === '~'
    ? path.join(os.homedir(), s.slice(2))
    : s;
```

`lane.code-workspace` update (replaces `python3` at `add-project:353-361`):
```js
const ws = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
ws.folders.push({ name: projectName, path: path.relative(path.dirname(workspaceFile), actualPath) });
await atomicWrite(workspaceFile, JSON.stringify(ws, null, 2) + '\n');
```

`git:` block replacement in context YAML (replaces `sed` at `add-project:191`; note: bash sed has EOF edge case when git block is the last section):
```js
const lines = existing.split('\n');
let inGit = false;
const stripped = lines.filter(l => {
  if (/^git:/.test(l))         { inGit = true;  return false; }
  if (inGit && /^[a-zA-Z]/.test(l)) inGit = false;
  return !inGit;
}).join('\n').trimEnd();
const newContent = stripped + '\n\n' + GIT_BLOCK_STRING;
```

Git clone/init via array args (no shell, cross-platform):
```js
execFileSync('git', ['clone', sourceUrl, destDir], { stdio: 'inherit' });
execFileSync('git', ['init', destDir], { stdio: 'ignore' });
```

`--copy` mode: `fs.cpSync(src, dest, { recursive: true })` (stable Node 20 API, replaces `cp -r`).

#### `scripts/statusline.js` — hot-path structure

Entry point must guarantee stdout emission even on error:
```js
process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', async () => {
  try { await main(raw || '{}'); }
  catch { process.stdout.write('\n'); }
});
```

`main()` execution order:
1. `JSON.parse(raw)` — extract `sessionId`, `transcript_path`, `cwd`, model, cost, duration, lines
2. Derive sessionId from transcript filename if absent (UUID regex, replicating `statusline:62-68`)
3. Sidecar: `JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))` in `try/catch`
4. `const t = await readTranscript(transcriptPath)` — `{ tokens, lastUsage, ... }`
5. CTX% from `t.lastUsage`: sum `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; divide by threshold; zone thresholds: critical ≥ 85%, warning ≥ 60% (replicating `statusline:182-184`)
6. `execFileSync('git', ['-C', gitTarget, 'branch', '--show-current'])` + `execFileSync('git', ['-C', gitTarget, 'status', '--porcelain'])`
7. Sidecar write-back via `atomicWrite` only when `curCost !== incomingCost` (replicating `statusline:232-253`)
8. Build output segments with ANSI colors
9. `process.stdout.write(out + '\n')`

Color gating (AC-15):
```js
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const R     = USE_COLOR ? '\x1b[0m'                 : '';
const BRAND = USE_COLOR ? '\x1b[38;2;249;115;22m'   : '';
const HEALTHY  = USE_COLOR ? '\x1b[38;2;16;185;129m'  : '';
const WARNING  = USE_COLOR ? '\x1b[1;38;2;245;158;11m': '';
const CRITICAL = USE_COLOR ? '\x1b[1;38;2;239;68;68m' : '';
const MUTED    = USE_COLOR ? '\x1b[38;2;136;136;136m' : '';
const DIM      = USE_COLOR ? '\x1b[2m'               : '';
```

Token formatting (replaces `fmt_tokens()` at `statusline:256-263`):
```js
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + 'k';
  return String(n);
}
```

Model shortname (replicates `statusline:138-145`):
```js
function shortModel(m) {
  if (/opus/i.test(m))   return 'opus';
  if (/sonnet/i.test(m)) return 'sonnet';
  if (/haiku/i.test(m))  return 'haiku';
  return m || 'claude';
}
```

### 6.2 Data Model Changes

None. Sidecar schema, `lane.code-workspace` JSON, and `.ai-contexts/*.yaml` format are unchanged. The additive `lastUsage` field in `readTranscript`'s return is not persisted.

### 6.3 Architecture

| File | Action | Notes |
|------|--------|-------|
| `scripts/_lib/transcript.js` | Modify | Add `lastUsage` to return; 5-line change at line 32 + 71 |
| `scripts/fresh-context.js` | New | Port (248 bash lines → ~200 Node lines) |
| `scripts/list-projects.js` | New | Port (155 bash lines → ~150 Node lines) |
| `scripts/add-project.js` | New | Port (367 bash lines → ~280 Node lines) |
| `scripts/statusline.js` | New | Port (355 bash lines → ~300 Node lines) |
| `scripts/fresh-context` | Modify | Replace with 2-line wrapper stub (`exec node ./scripts/<name>.js "$@"`) |
| `scripts/list-projects` | Modify | Replace with 2-line wrapper stub (`exec node ./scripts/<name>.js "$@"`) |
| `scripts/add-project` | Modify | Replace with 2-line wrapper stub (`exec node ./scripts/<name>.js "$@"`) |
| `scripts/statusline` | Modify | Replace with 2-line wrapper stub (`exec node ./scripts/<name>.js "$@"`) |
| `.claude/settings.json` | Modify | `statusLine.command` value only |
| `tests/scripts/fresh-context.test.js` | New | Integration tests |
| `tests/scripts/list-projects.test.js` | New | Integration tests |
| `tests/scripts/add-project.test.js` | New | Integration tests |
| `tests/scripts/statusline.test.js` | New | Integration tests |
| `tests/fixtures/statusline-input.json` | New | Minimal CC statusline payload |

### 6.4 Dependencies

`node:fs`, `node:fs/promises`, `node:path`, `node:child_process`, `node:readline`, `node:os`, `node:test` — all stdlib, zero new npm packages. `git` on PATH required for git-reading operations; missing git degrades gracefully (segment omitted, no throw). No `jq`, `yq`, `python3`, or `awk` required after the port.

---

## 7. Implementation Notes

- **`statusline.js` must guarantee stdout**. Wrap entire `main()` body in `try/catch { process.stdout.write('\n'); }`. Uncaught exceptions must produce an empty line, never a frozen statusline.

- **`add-project.js` sed fix** (`add-project:191`): The bash sed range `/^git:/,/^[a-z]/` never closes if the git block is at EOF, leaving old content. The Node `inGit` flag filter handles EOF correctly. Note this fix in the commit message.

- **`parseSimpleYaml` stays inline** in each consumer. Do not extract to `_lib/yaml-mini.js` — two consumers, no third in scope, per project rules against premature abstraction.

- **`list-projects.js` concurrency**: `Promise.all` over all entries. For N ≤ 20 (typical workspace), no semaphore needed. If profiling shows contention, add a manual counter-based semaphore inline (no npm package).

- **`fresh-context.js` sidecar priority**: `--session-id` arg > `CLAUDE_SESSION_ID` env > most-recent sidecar by mtime — identical to `fresh-context:84-95`.

- **Test pattern** (mirrors `tests/hooks/session-stop.test.js:14-29`): `fs.mkdtemp` per test, `spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tempDir, input: stdinStr, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })`. Disable color in tests for stable string assertions.

- **Wrapper stubs** (preserve existing callers — `pre-compact.sh:16` invokes `scripts/fresh-context` directly):
  ```bash
  #!/usr/bin/env bash
  exec node "$(dirname "${BASH_SOURCE[0]}")/$(basename "$0").js" "$@"
  ```
  Each of the four originals is replaced with this 2-line stub. The stub forwards args, inherits stdio, and replaces the bash process via `exec` so the exit code matches the `.js` exit code 1:1. Caller migration (updating `pre-compact.sh` to call `.js` directly) is a follow-up cleanup, not part of Phase 3.

- **`add-project.js` source-type detection order** (replicates `add-project:82-100`): Git URL patterns first (GitHub, Bitbucket, GitLab, Azure), then local path heuristics (`/` prefix, `~/` prefix, `./` prefix, or `fs.existsSync` returning true), then treat as new project name.

- **`fresh-context.js` cost line**: show `$X.XX · Prompts: N · Lines: +A / -R` only when `costUsd > 0`; else show `Prompts: N` only (replicating `fresh-context:154-159`).

- **Git diff stats in statusline.js** (replicates `statusline:113-120`): parse `git status --porcelain` line-by-line with regex, count modified (`/^.M|^M/`), staged (`/^[MADR]/`), untracked (`/^\?\?/`), compose `~N +N ?N` string segments.

---

## 8. Cost & Performance Budget

### `statusline.js` (basis for AC-12)

| Step | Target |
|------|--------|
| stdin accumulate + `JSON.parse` | < 5 ms |
| Sidecar `readFileSync` + `JSON.parse` | < 5 ms |
| `readTranscript` readline pass (10 MB transcript) | < 100 ms |
| `git branch --show-current` (execFileSync, warm) | < 20 ms |
| `git status --porcelain` (execFileSync, warm) | < 30 ms |
| Sidecar `atomicWrite` (conditional, skipped when cost unchanged) | < 5 ms |
| String build + `process.stdout.write` | < 1 ms |
| **Total (hot path)** | **< 166 ms** |

Cold JIT start (~40–80 ms) is excluded from the 200 ms budget — it is a one-time cost on the first keypress of a session. The bash version spends ~50–80 ms on `jq` fork+exec alone; the Node port eliminates all forking except two `git` calls.

If transcript grows beyond ~50 MB, the readline pass may breach 200 ms. `DEBUG_STATUSLINE=1` env var logs elapsed time to stderr for profiling.

### `list-projects.js` (basis for AC-5)

| Scenario | Target |
|----------|--------|
| 10 projects, parallel git remote reads | < 800 ms |
| 20 projects, parallel | < 1.5 s |
| Bash baseline (sequential, 10 projects) | ~1–2 s |

---

## 9. Risks & Open Questions

### Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `readTranscript` exceeds 200 ms on > 50 MB transcripts | Medium | `DEBUG_STATUSLINE=1` profiling; if hit in production, add tail-based fast path reading only the last N KB |
| `fs.symlinkSync` type `'junction'` fails on Wine / WSL1 | Low | WSL2 is the supported Windows environment; WSL1 users see a clear Node error |
| `parseSimpleYaml` misparses values with interior colons (e.g. `refined: "fix: PROJ-123"`) | Medium | Strip outer quotes in capture group; interior-colon values are always quoted by Lane's write scripts |
| `add-project.js` git-block strip leaves old content at EOF | Low | `inGit` flag loop terminates at end of array; no unclosed range possible |
| Wrapper stub doesn't forward signals correctly | Low | `exec` (no fork) replaces the bash process with node, so signal handling is identical to invoking `.js` directly. CI matrix includes the bash-stub invocation path for `fresh-context` via `pre-compact.sh`. |
| `fs.cpSync` unavailable if Node < 16.7 | Very low | Node 20+ required (Phase 1 establishes this); `fs.cpSync` stable in Node 20 |

### Open Questions — all resolved

**OQ-1 — PR structure. RESOLVED**: One branch, four commits (one per script + one for `transcript.js` + `settings.json`), single PR. Four small commits keep bisect clean.

**OQ-2 — Windows symlink strategy. RESOLVED**: Auto-detect `process.platform === 'win32'`; use `'junction'` type transparently. No `--junction` flag — requiring Windows users to know about it defeats portability. Log `linked (junction)` to stdout.

**OQ-3 — `list-projects.js` git remote concurrency. RESOLVED**: `Promise.all`, `execFile` async, 3 s timeout per call. No throttling for N ≤ 20.

**OQ-4 — `statusline.js` transcript read strategy. RESOLVED**: Reuse `readTranscript` (one full-file readline pass) extended with `lastUsage`. No re-read, no second pass. Confirmed within 200 ms budget.

**OQ-5 — `yq` replacement. RESOLVED (changed from prompt recommendation)**: Inline `parseSimpleYaml` regex (option b, not option a — "always omit workflow section"). Rationale: the Node port has no `yq` at all; omitting the workflow section permanently would be a regression. The target keys are simple scalars written by Lane's own scripts and safe for regex parsing. The helper is 8 lines, inline, no new file.

---

## Appendix: File Map

```
scripts/
  fresh-context.js          ← NEW (port)
  fresh-context             ← MODIFY: 2-line wrapper stub (exec to .js)
  list-projects.js          ← NEW (port)
  list-projects             ← MODIFY: 2-line wrapper stub (exec to .js)
  add-project.js            ← NEW (port)
  add-project               ← MODIFY: 2-line wrapper stub (exec to .js)
  statusline.js             ← NEW (port)
  statusline                ← MODIFY: 2-line wrapper stub (exec to .js)
  fresh-context.cmd         ← NEW: 2-line cmd-shell stub for Windows (AC-18)
  list-projects.cmd         ← NEW: 2-line cmd-shell stub for Windows (AC-18)
  add-project.cmd           ← NEW: 2-line cmd-shell stub for Windows (AC-18)
  statusline.cmd            ← NEW: 2-line cmd-shell stub for Windows (AC-18)
  _lib/
    transcript.js           ← MODIFY: add lastUsage to return value (additive, ~5 lines)
.claude/
  settings.json             ← MODIFY: statusLine.command value only
.github/workflows/
  cross-os-smoke.yml        ← VERIFY: Phase 3 tests run on all 3 OSes (AC-22)
tests/scripts/
  fresh-context.test.js     ← NEW
  list-projects.test.js     ← NEW
  add-project.test.js       ← NEW
  statusline.test.js        ← NEW
tests/fixtures/
  statusline-input.json     ← NEW (minimal CC statusline payload)
```

### Per-script effort estimates

| Script | Source lines | Complexity | Impl + test |
|--------|-------------|-----------|-------------|
| `list-projects.js` | 155 | Low | 2 h |
| `fresh-context.js` | 248 | Medium | 3 h |
| `statusline.js` | 355 | High (perf, sidecar write-back, CTX%) | 4 h |
| `add-project.js` | 367 | High (symlink/junction, YAML edit, 4 source types) | 4 h |
| `transcript.js` additive | +5 lines | Trivial | 30 min |

---

*Grounded on: `scripts/fresh-context` (248 lines), `scripts/list-projects` (155 lines), `scripts/add-project` (367 lines), `scripts/statusline` (355 lines), `scripts/_lib/transcript.js`, `scripts/_lib/cost.js`, `scripts/_lib/process.js`, `scripts/_lib/log-rotate.js`, `scripts/_lib/heuristics.js`, `.claude/settings.json`, `tests/hooks/session-stop.test.js`, `tests/scripts/reconcile.test.js`, `docs/specs/spec-2026-05-06-task-summaries.md`, `docs/superpowers/plans/2026-05-06-node-port-phase-1-session-stop.md:1-60`.*
