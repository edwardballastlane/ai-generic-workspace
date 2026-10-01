# Hook-System Improvements #4/#5/#6 — Design

**Status:** Draft, pending review
**Context:** Follow-on to landed items #1 (matcher-scoped Pre/PostToolUse — already present), #2 (Jaccard rule scoring), #3 (semantic rule fallback via cached Qdrant queries). All three items below extend the `UserPromptSubmit` / `Stop` hook chains. Each item is independent and can be landed separately.

---

## #4 — UserPromptSubmit dispatcher consolidation

### Problem
`.claude/settings.json:30-47` fires three separate processes on every user prompt:
1. `./scripts/hooks/inject-context.sh` (bash)
2. `node ./scripts/hooks/inject-rules.js`
3. `node ./scripts/hooks/context-budget.js`

Each incurs its own Node / bash startup overhead (~40-80ms per process on this machine) and emits its own stdout block, which means three separate `UserPromptSubmit hook success:` blobs in every turn's context. The starter-ai-workspace pattern (`.claude/helpers/hook-handler.cjs` dispatcher) collapses all UserPromptSubmit work into one process.

### Design
Create `scripts/hooks/user-prompt-dispatcher.js` with a command map:

```js
const handlers = {
  'inject-context': () => require('./inject-context-impl').run(input),
  'inject-rules':   () => require('./inject-rules-impl').run(input),
  'context-budget': () => require('./context-budget-impl').run(input),
};
```

The dispatcher reads stdin once, parses the prompt + cwd, then calls each handler **in the same process** with the parsed input. Each existing hook script is split into a `*-impl.js` module (pure function, takes `{ prompt, cwd, parsed }`, returns a string to print) plus a thin CLI shim that preserves the standalone call sites (tests, manual invocation).

`settings.json` becomes:

```json
"UserPromptSubmit": [
  { "hooks": [{
    "type": "command",
    "command": "node ./scripts/hooks/user-prompt-dispatcher.js",
    "timeout": 3000
  }]}
]
```

### Acceptance criteria
- Single `UserPromptSubmit hook success:` block per turn (concatenated outputs separated by `\n---\n` so `inject-context.sh`'s existing `<no-active-session>` XML still parses).
- Wall-time p95 ≤ current sum minus 80ms (measured via `/usr/bin/time` over 20 prompts).
- `inject-context.sh`, `inject-rules.js`, `context-budget.js` standalone entry points still work (existing test: `echo '{...}' | node inject-rules.js`).
- No behavior change for downstream consumers of the injected blocks.

### Risks
- **Partial-failure fan-in**: if one handler throws, the others must still run. Wrap each call in `try/catch` and keep partial output.
- **inject-context.sh is bash, not JS.** Two paths: (a) port to JS inside the dispatcher, (b) `spawnSync` bash from within the dispatcher. (a) is cleaner but larger scope — stage it as a follow-up if the bash logic is non-trivial.
- Stdin can only be read once; dispatcher must buffer the JSON and pass it to handlers as a JS object, not re-stream.

### Effort
~1 hour (handlers are already pure-ish).

---

## #5 — MEMORY.md section injection alongside rules

### Problem
`MEMORY.md` is loaded by Claude Code's native memory system, but its **content** is not used for relevance matching against the prompt. It sits in the context whether relevant or not (truncated after 200 lines). Rules are matched via Jaccard; memories are not.

The starter-ai-workspace `intelligence.cjs:53-95` already demonstrates this: it parses `MEMORY.md` into `## ` sections, tokenizes each, and ranks by Jaccard against the prompt — identical machinery to #2.

### Design
Extend `inject-rules.js` (or the post-#4 `inject-rules-impl.js`) to optionally ingest `MEMORY.md` sections as an additional scoring pool:

1. **Discovery**: Load `~/.claude/projects/<encoded-workspace>/memory/MEMORY.md` (path already referenced in CLAUDE.md). Parse by `^## ` headings; for each section, capture `{ title, body, sourcePath }`.
2. **Enrichment**: For each section, if the title links to a sub-file (`[Title](file.md)`), resolve and inline the first ~500 chars of that file for richer token coverage.
3. **Scoring**: Run the same Jaccard scoring as rules, with thresholds tuned separately (`MEMORY_STRICT = 0.06`, `MEMORY_RELAXED = 0.025` — memories are longer, so overlap densities differ).
4. **Injection format**: Separate section in the output so memories and rules are visually distinct:

   ```
   [N rules + M memories injected ...]
   Relevant learned rules:
   - ...

   Relevant memories:
   - <section title>: <first sentence>
   ```

5. **Caps**: top 3 memories, never inject sections shorter than 40 chars (likely index pointers).

### Acceptance criteria
- Memories fire on prompts where their keywords overlap but rules don't (e.g., "what's my RUC for the invoice" → Ecuador-tax memory).
- Memory injection is opt-out via `INJECT_MEMORY_SECTIONS=0`.
- No duplicate content: if a memory links to a synced-rule file, dedupe against rule IDs already injected.
- Hook wall-time p95 stays < 100ms (parsing MEMORY.md is cheap; sub-file reads are the risk — bounded to 5 per invocation).

### Risks
- **Privacy/noise**: memory files sometimes contain personal notes (Ecuador tax, e2e preferences). Fine as long as we're injecting to our own context, but avoid logging memory content to effectiveness/value-logger.
- **Sub-file reads**: must be best-effort with try/catch; one missing file can't crash the hook.
- **Truncation alignment**: Claude Code already loads MEMORY.md as context — we're adding a *relevance-ranked pointer* on top, not replacing. Be explicit in the injected block ("highlighted from MEMORY.md based on prompt overlap").

### Effort
~1 hour if discovery path is already known; +1h if we need to handle symlinks / cross-project memory.

---

## #6 — Stop-hook auto-memory sync back to MEMORY.md

### Problem
Today, `scripts/hooks/session-stop.sh` logs token/cost events and fires an async Qdrant embed of the transcript. It does **not** update `MEMORY.md`. Lessons learned in a session evaporate unless the user manually types "save this to memory" mid-session. The starter-ai-workspace `auto-memory-hook.mjs` (Stop → sync) closes this loop.

### Design
Introduce `scripts/hooks/memory-sync.ts`, fired from `Stop`:

1. **Input**: path to the just-ended transcript (`$TRANSCRIPT`, already passed to `session-stop.sh`).
2. **Extraction**: Stream-scan the transcript for assistant turns containing memory-save intent signals:
   - Explicit: "save to memory", "remember this", "note for later" (regex, high confidence).
   - Implicit: user feedback confirming a non-obvious approach (e.g., "yes exactly", "keep doing that") — lower confidence, queued as a **proposal**, not auto-written.
3. **Proposal queue**: Write candidates to `.ai-memory/memory-proposals.jsonl` with `{ ts, type, content, confidence, sessionId }`. High-confidence items (explicit saves) are written directly to `memory/<slug>.md` + a line appended to `MEMORY.md`.
4. **Review command**: `npm run memory:review` (new) opens the proposals file and prompts user to accept/reject (stays offline-friendly, reuses `scripts/self-improvement/proposal-manager.ts` pattern already in the repo).
5. **Sync direction is one-way (session → MEMORY.md)**. No inverse sync — if the user edits MEMORY.md manually, we don't touch it.

### Data model
```jsonl
{"ts":1714003200000,"sessionId":"20260424-100616","type":"user","title":"testing prefs","slug":"feedback_e2e_only","content":"...","confidence":0.9,"status":"auto-applied"}
{"ts":1714003250000,"sessionId":"20260424-100616","type":"project","title":"merge freeze","slug":"project_mobile_freeze","content":"...","confidence":0.55,"status":"pending-review"}
```

### Acceptance criteria
- Explicit "save to memory" in a session produces a new `memory/<slug>.md` with correct frontmatter and a `MEMORY.md` index line within 5s of session end.
- Implicit feedback (quieter confirmations) never writes without review — always lands in `memory-proposals.jsonl`.
- Hook runs with stdio: ignore; transcript never surfaces errors.
- Runs in < 3s for transcripts up to 5MB (we already embed the same transcript asynchronously; reuse chunking logic from `scripts/session-embedder/chunker.ts`).
- `npm run memory:review` round-trip works: approve → file written, reject → entry marked `dismissed`.

### Risks
- **False positives**: The model may casually say "I'll remember" mid-response. Mitigate by requiring (a) user turn explicit save OR (b) assistant turn explicit save AND user confirmation in the next turn.
- **Double-counting**: ensure a proposal isn't created if the content already exists verbatim in an existing memory file (dedupe by content hash before appending to `memory-proposals.jsonl`).
- **Stop-hook budget**: existing timeout is 5000ms and we already embed the transcript there. Memory extraction must run detached (nohup + disown, same pattern as lines 128-133 of `session-stop.sh`).
- **Retention**: `.ai-memory/memory-proposals.jsonl` grows unbounded. Add a `npm run memory:prune` to drop entries older than 14 days or already applied.

### Effort
~2-3 hours. The heavy lifting (transcript parsing, proposal manager) has precedent in `scripts/self-improvement/`.

---

## Sequencing

```
#4 (dispatcher consolidation)  ─┬─► enables #5 to drop into one place
#5 (MEMORY.md injection)       ─┘
#6 (auto-memory sync)          ── independent of #4/#5
```

Recommended order: **#4 → #5 → #6**. #4 removes noise before we add memory injection output. #6 is fully independent and could be done in parallel with #4/#5 by a second session.

## Rollout

- Each item lands behind an env flag first (`DISPATCHER_ENABLED`, `INJECT_MEMORY_SECTIONS`, `MEMORY_SYNC_ENABLED`).
- After a week of telemetry (rule-firing counts in `effectiveness.json` + new `memory-firing-counts.json`), flip defaults to on.
- Rollback is a one-line env change, no migration.

## Open questions

- Does `MEMORY.md` live at `~/.claude/projects/<encoded-workspace-path>/memory/MEMORY.md` or under the workspace? (Confirmed: `~/.claude/projects/...`. Project-encoded path.) The hook must resolve this dynamically, not hard-code.
- Should `#6` proposals be surfaced in-session (e.g., a `[memory candidates: N]` line at next SessionStart) or purely offline? Lean offline for now; in-session nudge is a future polish.
- Do we want memory injections in the same `UserPromptSubmit hook success:` block as rules, or a separate `SessionStart`-only injection? Same block keeps things simple; SessionStart-only risks staleness across a long session.
