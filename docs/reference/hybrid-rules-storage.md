# Hybrid Rules Storage (Prototype)

## The problem

This workspace has two places that can inject learning context on every prompt:

1. **Custom hook** — `scripts/hooks/inject-rules.js` reads `rules.json` + `rules-shared.json`, does keyword matching, injects top 8
2. **Native Claude Code memory** — `~/.claude/projects/<workspace>/memory/` is auto-loaded by Claude Code itself on every session

Today we only use (1). The risk of adding (2) without coordination is **double-loading** — both sources inject overlapping learning context.

## The hybrid approach

Split responsibility by audience:

| Rule type | Stored in | Shared via | Loaded by |
|-----------|-----------|------------|-----------|
| **Team** (curated, high-signal) | `scripts/self-improvement/rules-shared.json` | git | Custom hook `inject-rules.js` |
| **Personal** (high-reinforcement, validated) | `~/.claude/projects/<workspace>/memory/synced-rules/` | not shared (per-user) | Native Claude Code memory |

This gives team rules the git-sharing and keyword-filtering they need, while letting personal rules use Claude Code's native compaction/loading.

## What the prototype does

`scripts/self-improvement/sync-to-native-memory.js`:

- Reads `rules.json`
- Filters to rules with `status: "active"` AND `reinforcementCount >= 10` (empirically validated)
- Writes each as an individual markdown file with YAML frontmatter in `~/.claude/projects/<workspace>/memory/synced-rules/`
- Updates `MEMORY.md` index with one-line entries

## What it does NOT do (yet)

The prototype is **not wired into the hook chain**. If you run `--apply`, personal rules end up in both places:

- `rules.json` (still injected by `inject-rules.js`)
- Native memory (also auto-loaded by Claude Code)

That means **double injection**. Don't use it in production yet.

## Path to production

To fully migrate, the sequence is:

1. Run `npm run rules:sync-to-native-apply`
2. Modify `inject-rules.js` to ONLY read `rules-shared.json` (skip personal `rules.json`)
3. Decide what to do with existing personal rules with `reinforcementCount < 10` — either archive or keep in `rules.json` for continued reinforcement tracking

## Commands

```bash
npm run rules:sync-to-native           # dry-run — show what would sync
npm run rules:sync-to-native-apply     # actually write files
npm run rules:sync-to-native-clean     # remove all synced files
```

## Trade-offs

**Pro:**
- Native memory gets CC's compaction/loading for free
- Reduces custom hook scope (only team rules in keyword matcher)
- Cleaner mental model: team = shared tactical rules, personal = individual preferences

**Con:**
- Native memory is per-user path-based — no way to share personal rules across machines
- Personal rules lose reinforcement tracking once migrated (CC doesn't track rule fires)
- Two code paths to maintain until migration is complete
