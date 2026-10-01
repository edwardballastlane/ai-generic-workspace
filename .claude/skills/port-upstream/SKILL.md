---
name: port-upstream
description: >
  Find what this generic workspace is missing relative to the upstream project workspace it was
  forked from, then port the portable parts across and scrub the project-specific vocabulary out.
  Use this skill whenever the user says "what's missing from the generic workspace", "check
  workspace drift", "the workspaces drifted apart", "port X from the upstream workspace", "sync the
  upstream workspace into this one", "genericize this feature", "bring over the memory system",
  "what did we not port yet", or asks to compare two Lane workspaces. Trigger it for both the
  audit half ("what's missing?") and the execution half ("port it"). This is recurring maintenance:
  the project workspace is where features are built first, this one is where they are made generic.
---

# Port Upstream

The project workspace (configured in `.ai-config/upstream.json`) is where Lane features get
built against real work. This workspace is the generic distribution. They drift constantly.
This skill closes the gap without dragging project vocabulary across.

## 1. Measure the drift

```bash
npm run drift            # portable gaps, grouped by area
npm run drift:summary    # area counts only
npm run drift -- --all   # + project-specific and local-only files
npm run drift -- --area scripts/_lib
npm run drift -- --json  # for tooling
```

Every difference lands in one of four buckets:

| Bucket | Meaning | Action |
|--------|---------|--------|
| **Missing / portable** | Upstream-only file, zero project terms | Port as-is |
| **Missing / project-specific** | Upstream-only file that names the project | Port only if the *capability* is generic — then scrub |
| **Drifted / portable** | Exists both sides, upstream's added lines are clean | Merge upstream's additions |
| **Drifted / project-specific** | Upstream's added lines name the project | Merge selectively, scrub as you go |
| **Local-only** | This workspace added it | Nothing, or backport upstream |

`--json` gives per-file `terms` (which project words matched, and how often) so you can
judge coupling before opening anything.

## 2. Decide what is actually generic

A file being project-named does not make the capability project-specific. Ask:

- **Does the mechanism depend on the project's domain?** A ticket-prefix constant is generic
  (config it). An enricher that only understands that project's domain records is not.
- **Does it depend on the project's infra?** Hardcoded S3 buckets, hosted-agent ids, and
  Jira board ids are config, not blockers. A Lambda that only exists in that account is.
- **Does it pull in project repos?** A skill that shells into `<project>-backend` needs the repo
  path parameterized through `.ai-contexts/<project>.yaml` before they can come over.

Skip anything that fails all three. Record the decision (see step 6) so the next run does not
re-litigate it.

## 3. Port in dependency order

Never port a leaf before its library. The dependency spine is:

```
scripts/_lib/*          (pure modules, no side effects)
  -> scripts/hooks/*    (wire the libs into Claude Code lifecycle)
  -> scripts/*.js       (CLI entry points)
  -> package.json       (npm script aliases)
  -> .claude/commands/  (slash commands)
  -> .claude/skills/    (skills)
  -> docs/ + CLAUDE.md  (documentation)
  -> tests/             (port the upstream tests alongside, never after)
```

For each unit of work:

1. `cp` the upstream file(s), including their tests from the matching `tests/` path.
2. Follow its `require()` graph — port every `_lib` dependency it names first.
3. Scrub (step 4).
4. `npm test` before moving to the next unit.

Port one coherent capability at a time (the memory store, the ratchets, the fleet), not one
file at a time. A half-ported capability is worse than an un-ported one.

## 4. Scrub project vocabulary

```bash
npm run drift:scan -- scripts/_lib scripts/hooks   # exits 1 on any hit
```

Substitution rules:

| Upstream | Generic |
|----------|---------|
| `<PROJECT>_EVENTS_ROOT` and friends | `LANE_EVENTS_ROOT` |
| `ACME-1234` in examples | `PROJ-123` |
| Hardcoded project/repo names | read from `.ai-config/settings.yaml` or `.ai-contexts/<project>.yaml` |
| Hardcoded Jira prefix | `jira_prefix` from `.ai-config/settings.yaml` |
| Project-specific paths | resolve from the active project context |
| Domain jargon in comments | describe the mechanism, not the domain |

Do not leave a compatibility shim for the old env var name. Update the callers.

## 5. Verify

```bash
npm test                                   # the ported tests must pass here
npm run drift:scan -- <the paths you touched>
npm run drift:summary                      # the bucket you worked should have shrunk
```

A ported hook needs more than a passing unit test: start a session and confirm the hook
actually fires. Type-checking a hook proves nothing about whether Claude Code invokes it.

## 5b. Audit for completeness before declaring the cluster done

A cluster is not ported when its files are copied — it is ported when its *wiring* is.
Run this sweep; each line has caught a real gap:

```bash
# dangling requires in ported files
grep -ohE "require\('(\.[^']+)'\)" <files> | ...   # every relative require must resolve
# npm scripts pointing at files that do not exist
node -e "…Object.entries(require('./package.json').scripts)…"
# upstream tests whose subject module now exists here but the test does not
# settings.json hook registrations (env-var prefixes do not show as missing files)
diff <(node -e "…upstream .claude/settings.json hooks…") <(node -e "…local…")
# references to files that do not exist here (dead doc links, unported doc trees)
grep -ohE '(docs|scripts|tests)/[A-Za-z0-9_./-]+\.(md|js|json)' <files>
```

Two failure modes this catches that tests never will:

- **Write-only ports.** A store that fills but is never read; a recorder whose consumer
  was left behind. Ask: what *reads* what I just ported, and did that come over?
- **Config-only wiring.** An env var the code honours but nothing sets; a hook command
  prefix. These are invisible to a file-level diff.

Then widen `projectTerms` with any name the scrub missed, and re-scan — a term the list
does not know about is a term the gate cannot catch.

## 6. Record the run

Append to `docs/reference/upstream-port.md` under **Port log**: date, what came over, and
anything deliberately *not* ported with the reason. That log is what stops the next run from
rediscovering the same decisions.

If the port changed the surface area users see, update `CLAUDE.md` (the command/script tables)
in the same change.

## Gotchas

- **`.claude/settings.json` hook commands drift silently.** Diff them explicitly — an env var
  prefix added upstream will not show as a missing file.
- **Runtime data masquerades as source.** `staged-changes/`, `runs/`, `logs/`, `.ai-memory/`
  are already ignored in `.ai-config/upstream.json`; add new ones there rather than
  filtering by eye.
- **Upstream baselines are not portable.** `.deadcode-baseline.txt` and similar ratchet
  baselines encode the upstream codebase. Port the ratchet mechanism, regenerate the baseline.
- **`rules.json` is personal and local-only.** Never copy it or `rules-shared.json` between
  workspaces; they carry project-tagged rules.
- **Tests are the port's acceptance criteria.** If upstream has no test for the thing you are
  porting, write one here before you call it done.

## Configuration

`.ai-config/upstream.json` — upstream path, `projectTerms` (regexes, use `\b` on short words
so a short word like `cat` does not match `category`), `track` (paths to compare), `ignore` (regexes for
runtime data and project-only trees). Full schema in
[docs/reference/upstream-port.md](../../../docs/reference/upstream-port.md).
