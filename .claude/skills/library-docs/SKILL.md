---
name: library-docs
description: Look up current library/framework documentation and code examples via the ctx7 shell wrapper (Context7 API). Use when the user asks "docs for <lib>", "how do I use <lib>'s <API>", or needs up-to-date API usage for React, Next.js, NestJS, etc. Read-only; replaces the context7 MCP server.
---

# library-docs

Fetch live docs with `scripts/ctx7`. No MCP server, no API key.

## Steps

1. Resolve the library id:
   ```bash
   ./scripts/ctx7 search "<library name>"
   ```
   Output is tab-separated: `id`, `title`, `description`. Pick the best match (official docs repo, highest relevance).

2. Fetch docs for a narrow topic:
   ```bash
   ./scripts/ctx7 docs <id> --topic "<api or concept>" --tokens 3000
   ```
   Default is 5000 tokens. Use 2000-3000 for a single API; raise only if the answer is incomplete.

3. Answer from the returned text. Cite the `Source:` URLs it contains.

## Rules

- Read-only. The wrapper only issues GET requests.
- Always pass `--topic`; unfiltered docs waste context.
- One `search` plus one `docs` call is usually enough. Do not loop.
- On `ctx7: HTTP 429`, wait and retry once, then tell the user.
- If the library is not found, say so; do not answer from memory as if it were current docs.
