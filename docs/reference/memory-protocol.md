# Lane memory protocol (agent-callable, via the `lane-memory` MCP server)

Lane exposes a live, typed, per-project memory to the agent through the
`lane-memory` MCP server (`scripts/memory-mcp-server.js`, registered in `.mcp.json`).
It adopts the *interaction model* of a live agent memory (the agent reads and writes
mid-session) but is built on Lane's own store, dependency-free.

Unlike the prompt-hook rule injection (which pushes rules at you), this memory is
**pulled and written by the agent on demand** via MCP tools.

## Tools

| Tool | When to call it |
|------|-----------------|
| `mem_search(query, [type], [project], [limit])` | **Before starting work** — recall prior decisions / fixes / conventions. |
| `mem_context([project], [limit])` | At session start — the most recent observations for grounding. |
| `mem_save(title, content, [type], [tags], [project])` | **Proactively, without being asked**, after a design decision, a non-obvious fix, or a convention you learned. |
| `mem_get_observation(id)` | Fetch the full untruncated body of a search hit. |
| `mem_session_summary(title, content, [sessionId])` | Before declaring work done or after compaction — record what happened. |

## Ranking

`mem_search` ranks by **BM25** (IDF-weighted, length-normalized) by default — no model,
instant. Set **`LANE_MEMORY_SEMANTIC=1`** (in the MCP server's env) to enable **semantic
rerank**: the BM25 top-K candidates are re-ordered by cosine similarity using a local
bge-small embedder (`scripts/_lib/memory-embed.js`; ~130MB model, cached, loaded lazily on
first search). If the model can't load it falls back to BM25 — search never breaks.

## Observation types

`decision` · `bugfix` · `architecture` · `pattern` · `config` · `discovery` ·
`preference` · `feature` · `session_summary`

Content convention (markdown): **What / Why / Where / Learned.**

## Behavioral contract (what makes it useful)

1. **Recall first.** Run `mem_search` on the task's key nouns before writing code.
2. **Save as you go.** Call `mem_save` the moment you make a load-bearing decision or
   fix something non-obvious — don't wait to be asked. Memory that isn't written is lost.
3. **Summarize at the end.** Call `mem_session_summary` before "done".

## Scopes & privacy

Observations are stored locally in `.ai-memory/observations/<scope>.jsonl`
(`project` / `local` / `user`). Only `project`-scope, machine-authored observations
are ever shared; `local`/`user` never leave the machine.

## Team sharing (automatic)

- **session-stop** auto-exports your machine's locally-authored (`local:true`)
  observations to a per-user chunk `.ai-memory/observations-export/<you>.jsonl` (plain
  JSONL, PR-reviewable), staged + pushed by the existing session auto-commit.
- **session-start** auto-imports teammates' chunks (change-detected, idempotent), so
  `mem_search` sees the team's shared memory after a `git pull`.
- Manual: `npm run memory:share` (export + git add + PR hint), `memory:export`, `memory:import`.

**Merge conflicts on chunks resolve themselves.** An export rewrites your chunk wholesale
from the local store, and two clones sharing one `git user.name` write the *same* chunk
file — so both sides of a pull are full-file rewrites.

> **Known gap:** chunks are **not** routed through a merge driver in this workspace.
> `.gitattributes` covers the session-event and value-event logs only, and the registered
> `jsonl-union` driver unions on `(session_id, ts)` — not on the observation `id` these
> chunks are keyed by — so pointing chunks at it today would merge them incorrectly. Two
> clones exporting the same chunk between pulls will therefore conflict, and the conflict
> must be resolved by re-running `npm run memory:export` (which regenerates the chunk
> wholesale from the local store) rather than by hand-editing markers. Closing this needs
> the driver taught an `id` key plus the `.gitattributes` entry.

**No double-loading / context contamination:**
1. the store is idempotent by id (same observation never stored twice);
2. a `local` provenance flag means imported/migrated observations are never re-exported;
3. `mem_search`/`mem_context` exclude sources already injected by the prompt hook
   (`rules-shared`, `MEMORY.md`) — so the ExpeL rules KB (shared once via git) is not
   surfaced a second time through memory search. Pass `includeInjected:true` to override.

## Seeding from existing knowledge

The store is seeded from Lane's existing KB so it's useful on day one:

```bash
npm run memory:migrate        # rules-shared.json + MEMORY.md → typed observations (idempotent)
npm run memory:migrate:dry    # preview counts without writing
```

Run it once per clone (and after large rule promotions) to keep memory current.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `LANE_INJECT_MEMORY_OBS` | unset (off) | `=1` lets the prompt hook surface up to 3 prompt-relevant observations alongside the injected rules. Off by default because it adds a store read and extra tokens to **every** prompt; the MCP tools are the on-demand path and cost nothing when unused. |
| `LANE_TOON` | unset (off) | `=1` makes `mem_search` / `mem_context` emit their results array as TOON instead of JSON — a denser tabular encoding for uniform rows. Only the results array changes shape; error and single-object responses stay JSON. |
| `LANE_EVENTS_ROOT` | workspace root | Directory whose `.ai-memory/` receives session events, exports and the observation store. Set in `.claude/settings.json` so a session whose cwd sits inside `agent/_projects/<project>` still logs to the workspace, not the project. |
| `INJECT_MEMORY_SECTIONS` | on | `=0` disables `MEMORY.md` section injection in the prompt hook. |

Observation injection is deliberately separate from `INJECT_MEMORY_SECTIONS`: `MEMORY.md`
sections are hand-curated and few, observations are machine-written and many, so they
carry different defaults.
