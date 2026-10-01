# Specification: Node Port — Phase 7: Bootstrap + Token Dashboard

**Author**: Spec Writer
**Date**: 2026-05-06
**Status**: Draft — Ready for `/breakdown`
**Project**: `ai-generic-workspace`
**Branch (planned)**: `feat/node-port-phase-7-setup-token-dashboard` (base: Phase 6 tip; auto-rebases as upstream phases merge)
**Jira**: n/a

---

## 1. Problem Statement

Two bash scripts remained outside Phase 1–6 scope. Both are now visible blockers:

### `scripts/setup` (321 lines)

The **first instruction the README gives a new developer** is `./scripts/setup` (README:32). The script is interactive bash — 8 `read -p` prompts (lines 62, 228, 233, 236, 246, 249, 259, 299), ANSI colors, project-picker logic, writes `.ai-config/settings.yaml`. Every prior phase enumerated scripts to port and missed this one — it slipped past every search because:

1. Bootstrap chicken-and-egg: it's the script run *before* the workspace is "fully usable", so it got mentally excluded.
2. Naming collision: every grep for "setup" matched `setup-merge-drivers` and stopped.
3. Heavy interactive UX: 8 prompts plus ANSI rendering felt larger than the operational ports.

A Windows user cloning the repo and following `README.md:32` still needs bash to run `setup`. That contradicts Phase 5's "WSL no longer required" claim more directly than any operational script did.

### `scripts/token-dashboard.sh` (969 lines)

Phase 5 §3 deferred this with the rationale "TS dashboard at `scripts/session-embedder/dashboard-generator.ts` is the long-term replacement." That rationale is **wrong**: `dashboard-generator.ts` aggregates rule-lifecycle data (Qdrant, rules.json, value-events) into `dashboard-data.json`. `token-dashboard.sh` aggregates session-end-events into a token-consumption HTML dashboard. Different sources, different outputs, different consumers.

The bash script:
- Embeds a Python heredoc (lines 185+) for compaction-aware leg-reset detection (5% threshold), delta-based per-day/user/project attribution, multi-day session handling. The math has well-documented edge cases (sub-agent transient drops, prompts non-reset semantics).
- Embeds an HTML template heredoc (line 965+).
- Runs in the **Bitbucket master deploy step** (`npm run tokens:dashboard` → S3 upload). The pipeline already installs `python3 pip` for awscli, so python3 is available — but the bash dependency makes the deploy step Linux-only.
- Has 16 bash-isms (`jq`, `awk`, `sed`, `grep -E`).

**Who is affected**: All Lane workspace developers (setup at clone time on Windows) and the master CI (token-dashboard generates the publicly-served dashboard).

**Impact of not solving**: Windows developers can't follow the README's first instruction natively. The token-dashboard math sits in an embedded Python heredoc that nobody can unit-test in isolation. The two big bash scripts undermine the "Node port complete" claim from Phase 5/6.

---

## 2. Goals

1. Port `scripts/setup` to `scripts/setup.js` preserving interactive UX 1:1 (8 prompts, ANSI colors, project picker, settings.yaml write). Add `--config-file <path>` for non-interactive use (CI, scripted onboarding).
2. Port `scripts/token-dashboard.sh` to `scripts/token-dashboard.js` — bash + Python + embedded HTML all become one Node module. Eliminates `python3` from the master deploy hot path.
3. Behavioral parity for `token-dashboard.js`: leg-reset detection at the same 5% threshold, delta-based attribution, prompts via session aggregate (not delta), by_day/by_user/by_project/total tables identical line-by-line.
4. Each ported script has `tests/scripts/<name>.test.js` with at minimum 3 cases.
5. Bash stubs (`scripts/setup.sh`, `scripts/token-dashboard.sh` → 2-line stub) and Windows `.cmd` siblings exist for both.
6. `npm test` exits 0 on Linux, macOS, Windows (existing matrix).
7. `package.json` `tokens:dashboard` and `tokens:data` scripts updated to invoke `node ./scripts/token-dashboard.js`.
8. `bitbucket-pipelines.yml` master deploy step continues to work — same output file at `.claude/visualizations/token-dashboard.html`, same exit codes.

---

## 3. Non-Goals

- Changing the dashboard's visual design or chart layout. The HTML template moves to a Node template literal verbatim.
- Merging `token-dashboard.js` into `dashboard-generator.ts`. They are separate dashboards with different data sources; merging is a future architectural decision out of scope here.
- Changing the leg-reset threshold or the delta-attribution algorithm. The Python's documented edge cases (session 3fb7f2f5 calibration to 5%) are preserved exactly.
- Removing `python3 pip` install from `bitbucket-pipelines.yml` line 25 — it is still needed by `awscli`. This phase only removes Python from the *dashboard-generation* step, not the AWS upload step.
- Changing `.ai-config/settings.yaml` schema or the `setup` script's prompt order.
- Adding new prompts to `setup` (e.g., for new features). Strict 1:1 UX port plus the `--config-file` flag.
- Adding a `--non-interactive` flag distinct from `--config-file`. The presence of `--config-file` is sufficient signal.
- Replacing the inline `parseSimpleYaml` pattern from prior phases with a `js-yaml` dependency. Phase 7 follows the no-new-dependencies rule.

---

## 4. Acceptance Criteria

### setup.js (interactive bootstrap port)

**AC-1** — Given the user runs `node scripts/setup.js` with no arguments and `.ai-config/settings.yaml` does not exist, when the script executes, then it prints the orange banner, asks the 8 prompts in the same order as the bash original (per `scripts/setup:60-300`), and writes `.ai-config/settings.yaml` with the user's responses.

**AC-2** — Given `.ai-config/settings.yaml` already exists, when the user runs `node scripts/setup.js`, then it prints "Setup was already completed" with the existing config rendered, prompts "Do you want to reconfigure? (y/N)", and exits 0 if the answer is no (matches bash `setup:54-72`).

**AC-3** — Given `--config-file <path>` is passed and `<path>` is a valid YAML file with the expected schema (developer_name, primary_project, project_source, etc.), when the script runs, then it skips ALL interactive prompts, writes `.ai-config/settings.yaml` directly from the config-file values, and exits 0.

**AC-4** — Given the user passes `--info`, when the script runs, then it prints the MCP configuration summary (matching the `--info` behavior referenced at `README.md:319`) and exits 0 without modifying any file.

**AC-5** — Given `NO_COLOR=1` is set or `process.stdout.isTTY` is false, when the script runs, then ANSI escape sequences are NOT emitted (raw text only, no garbled output when piped).

**AC-6** — Given the project picker reaches option 1 (existing path), when the user enters a path that does not exist, then the script reprompts (per bash `setup:233-237`); given option 2 (git URL), when the URL is invalid format, then the script reprompts.

**AC-7** — `scripts/setup` becomes a 2-line bash stub (`exec node ... .js`); `scripts/setup.cmd` is created as the Windows stub. The bare-name invocation `./scripts/setup` continues to work on Linux/macOS, and `scripts\setup.cmd` works on Windows.

### token-dashboard.js (data + HTML port)

**AC-8** — Given `.ai-memory/session-end-events.jsonl` exists with N session_end events, when `node scripts/token-dashboard.js` runs, then it produces `.claude/visualizations/token-data.json` and `.claude/visualizations/token-dashboard.html`. Exits 0.

**AC-9** — Given `--json-only` is passed, when the script runs, then `token-data.json` is written but `token-dashboard.html` is NOT written or modified (matches bash mode at `token-dashboard.sh:5`).

**AC-10** — Given session events with a leg-reset pattern (cost_usd drops to <5% of prior leg max), when the script processes those events, then it identifies the leg boundary AT the same point the Python heredoc identifies, sums per-leg max for `cost_usd`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `lines_added`, `lines_removed` per `token-dashboard.sh:181-186`. The 5% threshold (`LEG_RESET_THRESHOLD = 0.05`) is preserved exactly.

**AC-11** — Given the same input, when both the bash original and the Node port are run on the same `.jsonl` file, then `token-data.json` produced by the Node port equals the bash output for `total.cost_usd`, `total.input_tokens`, and `total.prompts` to within 1 cent / 1 token / 1 prompt (rounding tolerance). Use a frozen fixture in `tests/fixtures/token-events-sample.jsonl`.

**AC-12** — Given an event with `prompts: 5`, when delta-based attribution applies, then `prompts` is NOT included in `DELTA_FIELDS` (per `token-dashboard.sh:194-197`). Prompts are attributed via the session aggregate (last event's `prompts` value per session), NOT via per-event delta.

**AC-13** — Given session events span multiple calendar days (same session_id, ts crossing midnight UTC), when delta attribution runs, then daily `by_day` table credits each day with the cost/token delta accrued on that day, NOT the full session total to the last event's day (matches the bash bug-fix comment at `token-dashboard.sh:188-193`).

**AC-14** — Given `token-dashboard.html` is generated, when a developer opens it in a browser, then the same charts render (Token usage by day, Cost by user, Top sessions, etc.). The HTML structure is byte-identical to the bash output where reasonable; cosmetic CSS may be reformatted by JS template literal indentation but visual rendering must match.

**AC-15** — Given `bitbucket-pipelines.yml` master deploy runs `npm run tokens:dashboard`, when the deploy step executes, then `python3` is NOT invoked anywhere by the dashboard-generation step (it remains in the script for `awscli` setup, but the dashboard generation is pure Node).

**AC-16** — `scripts/token-dashboard.sh` becomes a 2-line bash stub. `scripts/token-dashboard.cmd` is created.

### Cross-cutting

**AC-17** — `package.json` `scripts.tokens:dashboard` and `scripts.tokens:data` are updated to `node ./scripts/token-dashboard.js` and `node ./scripts/token-dashboard.js --json-only`. The `npm run tokens:dashboard` invocation in `bitbucket-pipelines.yml` continues to work without changes.

**AC-18** — `CLAUDE.md` is updated: the "Node port complete" section now cites Phases 1–7 (not 1–6). The Phase 7 spec path is added to the phase reference table.

**AC-19** — `npm test` exits 0 on `ubuntu-latest`, `macos-latest`, and `windows-latest` via the existing `cross-os-smoke.yml` matrix.

Total: **19 ACs** (7 setup + 9 token-dashboard + 3 cross-cutting).

---

## 5. Technical Design

### 5.1 Architecture

Two new files, both self-contained:

- `scripts/setup.js` — interactive bootstrap port + `--config-file` flag.
- `scripts/token-dashboard.js` — replaces bash + embedded Python + embedded HTML in one Node module.

### 5.2 setup.js — interactive prompts via `node:readline`

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function ansi(code, useColor) { return useColor ? code : ''; }

function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
    },
    close() { rl.close(); }
  };
}
```

Use `await prompter.ask("   Do you want to reconfigure? (y/N): ")` per prompt. Validate inputs in-line, reprompt on invalid (matches `setup:233-237` reprompt loop).

`--config-file <path>` short-circuits the interactive flow:
1. Parse positional argument: `const configFile = process.argv[process.argv.indexOf('--config-file') + 1]`.
2. Read YAML via the inline `parseSimpleYaml` helper used in Phase 3 (`scripts/list-projects.js`, `scripts/add-project.js`). Same scope: top-level keys only.
3. Validate required keys; abort with non-zero exit if missing.
4. Skip ALL `prompter.ask` calls; write `.ai-config/settings.yaml` directly.

ANSI colors gated by `useColor = !process.env.NO_COLOR && process.stdout.isTTY`.

### 5.3 token-dashboard.js — three-pass architecture

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Pass 1: load and group events by session_id, sort by ts.
// Pass 2: per-session leg-reset walk; emit per-leg max for cumulative fields.
// Pass 3: delta-attribute per-event to by_day, by_user, by_project tables.
```

**Pass 1** (replaces `token-dashboard.sh:155-170` bash loop):
```js
const events = fs.readFileSync(eventsFile, 'utf8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(e => e && e.type === 'session_end');

const groups = new Map();  // sid -> [events sorted by ts]
for (const e of events) {
  const sid = e.session_id || '';
  if (!sid) continue;
  if (!groups.has(sid)) groups.set(sid, []);
  groups.get(sid).push(e);
}
for (const evs of groups.values()) evs.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
```

**Pass 2 — leg-reset detection** (replaces Python lines 200-260):
```js
const LEG_RESET_THRESHOLD = 0.05;
const LEG_RESET_FIELDS = ['cost_usd', 'duration_ms',
  'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens',
  'lines_added', 'lines_removed'];

function aggregateSession(evs) {
  const legMax = Object.fromEntries(LEG_RESET_FIELDS.map(f => [f, 0]));
  const totalsLeg = Object.fromEntries(LEG_RESET_FIELDS.map(f => [f, 0]));
  let promptsMax = 0;
  for (const ev of evs) {
    const curCost = ev.cost_usd || 0;
    if (legMax.cost_usd > 0 && curCost < legMax.cost_usd * LEG_RESET_THRESHOLD) {
      for (const f of LEG_RESET_FIELDS) {
        totalsLeg[f] += legMax[f];
        legMax[f] = 0;
      }
    }
    for (const f of LEG_RESET_FIELDS) {
      legMax[f] = Math.max(legMax[f], ev[f] || 0);
    }
    promptsMax = Math.max(promptsMax, ev.prompts || 0);
  }
  for (const f of LEG_RESET_FIELDS) totalsLeg[f] += legMax[f];
  return { ...totalsLeg, prompts: promptsMax };
}
```

**Pass 3 — delta-based attribution** (replaces Python lines 260-340):
```js
const DELTA_FIELDS = ['cost_usd', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens',
  'lines_added', 'lines_removed'];  // NOT prompts (AC-12)

const byDay = new Map();
const byUser = new Map();
const byProject = new Map();

for (const evs of groups.values()) {
  const prevVals = Object.fromEntries(DELTA_FIELDS.map(f => [f, 0]));
  let prevCost = 0;
  for (const ev of evs) {
    const curCost = ev.cost_usd || 0;
    // Reset prev on leg boundary so delta is computed within a leg
    if (prevCost > 0 && curCost < prevCost * LEG_RESET_THRESHOLD) {
      for (const f of DELTA_FIELDS) prevVals[f] = 0;
    }
    const day = (ev.ts || '').slice(0, 10);
    const user = ev.user || 'unknown';
    const project = ev.project || 'unknown';
    for (const f of DELTA_FIELDS) {
      const delta = Math.max(0, (ev[f] || 0) - prevVals[f]);
      addTo(byDay, day, f, delta);
      addTo(byUser, user, f, delta);
      addTo(byProject, project, f, delta);
      prevVals[f] = ev[f] || 0;
    }
    prevCost = curCost;
  }
}
```

**Prompts via session aggregate** (per AC-12):
```js
for (const [sid, evs] of groups) {
  const agg = aggregateSession(evs);
  const lastEvent = evs[evs.length - 1];
  const day = (lastEvent.ts || '').slice(0, 10);
  // Add prompts to byDay, byUser, byProject by last-event metadata
  bumpPrompts(byDay, day, agg.prompts);
  bumpPrompts(byUser, lastEvent.user || 'unknown', agg.prompts);
  bumpPrompts(byProject, lastEvent.project || 'unknown', agg.prompts);
}
```

### 5.4 HTML template

Move the `HTMLEOF` heredoc at `token-dashboard.sh:965+` into a Node template literal:

```js
function renderHtml(jsonData) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Token Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>...</style>
</head>
<body>
  <script>
    const data = ${JSON.stringify(jsonData)};
    // chart rendering
  </script>
</body>
</html>`;
}
```

Substitution preserved 1:1 from the bash heredoc — no chart logic changes.

### 5.5 package.json updates

```json
"scripts": {
  ...
  "tokens:dashboard": "node ./scripts/token-dashboard.js",
  "tokens:data": "node ./scripts/token-dashboard.js --json-only",
  ...
}
```

### 5.6 Reused utilities

| Utility | Used by |
|---|---|
| `node:readline` | `setup.js` (interactive prompts) |
| `node:fs` | both scripts |
| Inline `parseSimpleYaml` | `setup.js` (`--config-file`) |
| Inline ANSI escape constants | both (gated by `NO_COLOR` + `isTTY`) |

No new `_lib/` utility. No new package dependencies. Reuse the inline `parseSimpleYaml` pattern from `scripts/list-projects.js` (Phase 3) by copy-paste — promoting it to `_lib/` is out of scope for Phase 7 (no new lib).

### 5.7 Bash stub pattern (preserved from Phase 6)

```bash
#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/setup.js" "$@"
```

(literal filename, not `$(basename ...)`)

```bash
#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/token-dashboard.js" "$@"
```

Windows `.cmd` siblings:

```bat
@echo off
node "%~dp0setup.js" %*
```

```bat
@echo off
node "%~dp0token-dashboard.js" %*
```

---

## 6. Cost & Performance

### setup.js
- Interactive UX. Latency is human-paced. No measurable impact.
- `--config-file` mode: < 100 ms (single YAML parse + file write).

### token-dashboard.js
- Bash baseline: ~5–15 s for ~2000-event JSONL on a workspace (jq + Python heredoc fork overhead).
- Node target: < 5 s for the same input. JSON.parse + in-memory loops should be faster than jq forks; eliminating the Python heredoc fork removes ~500 ms.
- Master deploy step: total wall-clock should drop slightly. No SLA, but verify in CI on first PR run.

---

## 7. Implementation Notes

**Order of porting (independent, port in either order)**:
1. `setup.js` — UX-driven, readable, no math complexity. Test interactivity via spawnSync with scripted stdin.
2. `token-dashboard.js` — math-heavy. Lock in correctness with a frozen fixture (`tests/fixtures/token-events-sample.jsonl`) that has the leg-reset edge case + multi-day session + prompts non-reset. Run bash + Node side-by-side on the fixture during dev to confirm output equality.

**Test fixtures for token-dashboard**:
- `tests/fixtures/token-events-sample.jsonl` — 8–12 synthetic events covering: simple session (one leg), compaction (cost drops to <5%), multi-day session (ts crosses midnight), prompts non-reset (prompts increases monotonically while cost resets).
- Helpers in the test file produce the expected `total`, `by_day`, `by_user`, `by_project` shapes; assert deep equality.

**Test pattern for setup.js**:
- Use `spawnSync('node', ['scripts/setup.js'], { input: <prompt-answers>, encoding: 'utf8', cwd: tempDir })` to drive interactive mode. Each `\n` in `input` is a prompt answer.
- For `--config-file` tests, write a fixture YAML and assert `.ai-config/settings.yaml` content.

**HTML template equivalence**:
- A snapshot test confirming the rendered HTML byte-for-byte equals a frozen fixture is too brittle. Instead, assert specific structural properties: presence of `<script src=".../chart.js">`, presence of expected `<canvas>` ids, presence of the JSON-stringified data block. Visual regression testing is out of scope.

**Embedded Python migration risks**:
- The Python uses `defaultdict` extensively. JS equivalent: `Map` with `get(...) ?? <default>` lazy initialization, or a small `addTo(map, key, field, value)` helper.
- Python's `groupby` semantics: not used; the bash-Python heredoc uses explicit dict accumulation, which maps directly to JS.

**`ts.localeCompare` ordering**: ISO 8601 strings sort lexicographically. Don't introduce a `Date` parse step in the sort callback — it's slower and unnecessary.

**Stdin mock for `setup.js` interactivity test on Windows**: the spawnSync `input:` option works on Windows; no special handling needed.

---

## 8. Risks & Open Questions

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R-1 | JS `Math.max` semantics differ from Python's `max(a, b)` for None / undefined | Low | Coerce with `(ev[f] || 0)` before max — explicit and matches Python's `ev.get(f, 0)` pattern. |
| R-2 | `localeCompare` of ISO 8601 timestamps could produce different ordering than Python's string sort | Low | ISO 8601 is sortable as plain string; `localeCompare` and `<` produce the same order. Use `<` directly to match Python's sort. |
| R-3 | HTML template literal escaping (e.g., backticks inside the template) | Medium | Use `String.raw` or escape backticks explicitly. Verify with snapshot of the rendered HTML start/end. |
| R-4 | The bash `--info` mode behavior is undocumented in the script header — only mentioned at `README.md:319` | Medium | Read the bash source carefully; preserve whatever `--info` actually does. May be a no-op stub (acceptable to preserve as-is). |
| R-5 | JSON.parse of a 100k-line `.jsonl` is loaded fully into memory; bash streamed via jq | Low | The events file is < 1 MB at typical sizes (~2000 events). In-memory split is fine. If we hit a 100 MB file later, switch to readline streaming. |
| R-6 | Bitbucket pipeline `npm run tokens:dashboard` invokes the package.json script. If we forget to update the script invocation in `package.json`, the deploy silently runs the bash stub (which still works) but doesn't exercise the Node port | Medium | Explicit AC-17 plus a smoke test in T7: `npm run tokens:dashboard` and assert the .js file is invoked (e.g., presence of a marker comment in the HTML output). |
| R-7 | `setup.js` `--config-file` validation differs from interactive prompts — CI scripts could write invalid YAML and the script accepts it | Low | Validate config-file required fields explicitly; error out with exit 1 + stderr message on missing fields. |

**Bugs found during spec review (file as follow-ups, do not fix in Phase 7)**:
- **BUG-1** (`token-dashboard.sh:188-193`): the delta-attribution bug-fix comment notes that pre-fix, multi-day sessions credited the full session total to the last event's day. The fix is in place in the bash. Node port preserves the fix; verify with the multi-day fixture.

---

## 9. File Map

**New files (6)**:

| File | Description |
|---|---|
| `scripts/setup.js` | Port of `scripts/setup`; interactive prompts via `node:readline`; `--config-file` non-interactive mode |
| `scripts/setup.cmd` | Windows cmd stub |
| `scripts/token-dashboard.js` | Port of `scripts/token-dashboard.sh`; bash + Python + HTML in one Node module; eliminates python3 from dashboard generation |
| `scripts/token-dashboard.cmd` | Windows cmd stub |
| `tests/scripts/setup.test.js` | ≥ 4 cases: interactive (scripted stdin), --config-file, --info, NO_COLOR |
| `tests/scripts/token-dashboard.test.js` | ≥ 5 cases: simple session, leg-reset, multi-day, prompts non-reset, --json-only |

**Modified files (4)**:

| File | Change |
|---|---|
| `scripts/setup` | Convert to 2-line bash stub delegating to `.js` |
| `scripts/token-dashboard.sh` | Convert to 2-line bash stub delegating to `.js` |
| `package.json` | `tokens:dashboard` and `tokens:data` scripts → `node ./scripts/token-dashboard.js` |
| `CLAUDE.md` | Phase 7 row added to phase reference table; "Node port complete" line cites Phases 1–7 |

**New fixtures (1)**:

| File | Description |
|---|---|
| `tests/fixtures/token-events-sample.jsonl` | 8–12 synthetic events with leg-reset, multi-day, prompts-non-reset edge cases |

**Deleted files**: None. The two `.sh` files remain as 2-line stubs.

---

## Grounding Citations

- Phase 5 deferral note (token-dashboard): `docs/specs/spec-2026-05-06-node-port-phase-5-complete.md` §3
- Phase 6 deferral list (operational scripts): `docs/specs/spec-2026-05-06-node-port-phase-6-operational-scripts.md` §3
- README first instruction: `README.md:32`
- README `--info` mode: `README.md:319`
- setup interactive prompts: `scripts/setup:60-300` (7 `read -p` calls at lines 62, 228, 233, 236, 246, 249, 259, 299)
- setup ANSI rendering: `scripts/setup:14-19`
- token-dashboard Python heredoc: `scripts/token-dashboard.sh:185-700` (approximate range)
- token-dashboard HTML heredoc: `scripts/token-dashboard.sh:965+`
- LEG_RESET_THRESHOLD = 0.05: `scripts/token-dashboard.sh:181`
- LEG_RESET_FIELDS list: `scripts/token-dashboard.sh:182-186`
- DELTA_FIELDS (excludes prompts): `scripts/token-dashboard.sh:194-197`
- Multi-day session bug-fix comment: `scripts/token-dashboard.sh:188-193`
- Bitbucket master deploy invocation: `bitbucket-pipelines.yml:25-29`
- package.json invocations: `package.json:48-49` (`tokens:dashboard`, `tokens:data`)
- Bash stub pattern: `scripts/fresh-context:1-2`
- Windows `.cmd` stub pattern: `scripts/fresh-context.cmd:1-2`
- Existing CI matrix path coverage (covers `scripts/**`): `.github/workflows/cross-os-smoke.yml:5-8`
- Inline parseSimpleYaml pattern: `scripts/list-projects.js` (Phase 3 reference)
